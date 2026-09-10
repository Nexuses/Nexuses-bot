import { dbConnect } from "@/lib/db";
import { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";
import { callBrevoMcpTool, listBrevoMcpTools } from "@/lib/brevo-mcp";
import {
  looksLikeQueryApiKeyAuth,
  looksLikeRawAuthorizationAuth,
  normalizeCustomBaseUrl,
  resolveCustomAuthType,
} from "@/lib/integrations";
import { Integration } from "@/models/Integration";
import { Automation } from "@/models/Automation";
import {
  serializeAutomation,
  type AutomationDTO,
  type AutomationSourceProvider,
  type SyncRecipe,
} from "@/lib/serialize-automation";
import {
  collectUnifiedPortalPeople,
  driveUnifiedPortalProcessDue,
  isUnifiedPortal,
  resolveUnifiedPortalCampaign,
} from "@/lib/unified-portal";
import {
  deleteUnifiedPortalWebhook,
  listUnifiedCampaignsSince,
  makeWebhookReceiveToken,
  registerUnifiedPortalWebhook,
  syncUnifiedCampaignEngagement,
} from "@/lib/unified-webhooks";
import {
  collectOutreachPeople,
  isNexusesOutreach,
  resolveOutreachCampaign,
} from "@/lib/nexuses-outreach";
import {
  isSmartLead,
  normalizeSmartleadEvent,
  registerSmartleadWebhook,
  smartleadWebhookPublicUrl,
  stageFromSmartleadEvent,
} from "@/lib/smartlead-webhooks";
import type { AuthType } from "@/types/chat";

const ATTIO = "https://api.attio.com";
const LEMLIST = "https://api.lemlist.com";

type StoredKey = {
  apiKey: string;
  mcpUrl?: string;
};

type CustomIntegration = {
  name: string;
  apiKey: string;
  baseUrl?: string;
  authType?: AuthType;
};

function attioHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function lemlistHeaders(apiKey: string) {
  return {
    Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

function customHeaders(integration: CustomIntegration): Record<string, string> {
  if (looksLikeQueryApiKeyAuth(integration)) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
  if (looksLikeRawAuthorizationAuth(integration)) {
    return {
      Authorization: integration.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
  const auth = resolveCustomAuthType(integration);
  if (auth === "api-key") {
    return { "api-key": integration.apiKey, "Content-Type": "application/json" };
  }
  if (auth === "basic") {
    return {
      Authorization: `Basic ${Buffer.from(`:${integration.apiKey}`).toString("base64")}`,
      "Content-Type": "application/json",
    };
  }
  return {
    Authorization: `Bearer ${integration.apiKey}`,
    "Content-Type": "application/json",
  };
}

function withQueryApiKey(url: string, apiKey: string) {
  const parsed = new URL(url);
  if (!parsed.searchParams.get("api_key")) {
    parsed.searchParams.set("api_key", apiKey);
  }
  return parsed.toString();
}

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asObjects(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["data", "campaigns", "leads", "activities", "contacts", "people", "results", "items"]) {
      if (Array.isArray(record[key])) return asObjects(record[key]);
    }
  }
  return [];
}

function getByPath(data: unknown, path: string): unknown {
  if (!path.trim()) return data;
  let cur: unknown = data;
  for (const part of path.split(".").map((p) => p.trim()).filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function pickField(item: Record<string, unknown>, preferred?: string, fallbacks: string[] = []) {
  const keys = preferred ? [preferred, ...fallbacks] : fallbacks;
  for (const key of keys) {
    const value = item[key];
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (Array.isArray(value) && value[0] != null) {
      const first = value[0];
      if (typeof first === "string" || typeof first === "number") return String(first).trim();
      if (first && typeof first === "object") {
        const nested = first as Record<string, unknown>;
        for (const nestedKey of ["email", "email_address", "value", "address"]) {
          if (nested[nestedKey]) return String(nested[nestedKey]).trim();
        }
      }
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ["email", "email_address", "value", "full_name", "name"]) {
        if (nested[nestedKey]) return String(nested[nestedKey]).trim();
      }
    }
  }
  return "";
}

async function getIntegration(
  userId: string,
  projectId: string,
  provider: "attio" | "lemlist" | "brevo",
): Promise<StoredKey> {
  await dbConnect();
  const doc = await Integration.findOne({ userId, projectId, provider }).lean();
  if (!doc?.apiKey) throw new Error(`${provider} is not connected`);
  return { apiKey: doc.apiKey, mcpUrl: doc.mcpUrl || "" };
}

async function getCustomIntegration(
  userId: string,
  projectId: string,
  name: string,
): Promise<CustomIntegration> {
  await dbConnect();
  const docs = await Integration.find({ userId, projectId, provider: "other" }).lean();
  const match = docs.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!match?.apiKey) throw new Error(`Custom API "${name}" is not connected`);
  return {
    name: match.name,
    apiKey: match.apiKey,
    baseUrl: match.baseUrl || "",
    authType: match.authType,
  };
}

async function resolveLemlistCampaign(apiKey: string, name: string) {
  const campaigns = asObjects(
    await requestJson(`${LEMLIST}/api/campaigns?limit=100&offset=0`, {
      headers: lemlistHeaders(apiKey),
    }),
  );
  const match =
    campaigns.find((item) => String(item.name || "").toLowerCase() === name.toLowerCase()) ||
    campaigns.find((item) => String(item.name || "").toLowerCase().includes(name.toLowerCase()));
  if (!match) throw new Error(`Lemlist campaign "${name}" not found`);
  return {
    id: String(match._id || ""),
    name: String(match.name || name),
    status: String(match.status || "").toLowerCase(),
  };
}

async function lemlistPeople(apiKey: string, campaignId: string, type: string) {
  const people = new Map<string, { email: string; name: string }>();
  for (let offset = 0; offset < 500; offset += 100) {
    const page = asObjects(
      await requestJson(
        `${LEMLIST}/api/activities?campaignId=${encodeURIComponent(campaignId)}&type=${encodeURIComponent(type)}&version=v2&limit=100&offset=${offset}`,
        { headers: lemlistHeaders(apiKey) },
      ),
    );
    for (const item of page) {
      const email = String(item.email || item.leadEmail || "").trim().toLowerCase();
      if (!email.includes("@")) continue;
      const name = [item.firstName, item.lastName].filter(Boolean).join(" ").trim();
      people.set(email, { email, name });
    }
    if (page.length < 100) break;
  }
  return [...people.values()];
}

async function resolveAttioList(apiKey: string, listName: string) {
  const lists = (await requestJson(`${ATTIO}/v2/lists`, {
    headers: attioHeaders(apiKey),
  })) as { data?: { name?: string; api_slug?: string; id?: { list_id?: string } }[] };
  const list = (lists.data || []).find(
    (item) => item.name?.toLowerCase() === listName.toLowerCase(),
  );
  if (!list) throw new Error(`Attio list "${listName}" not found`);
  const listId = list.id?.list_id || list.api_slug || "";
  const attributes = (await requestJson(
    `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes`,
    { headers: attioHeaders(apiKey) },
  )) as { data?: { api_slug?: string; type?: string; title?: string }[] };
  const statusAttr =
    (attributes.data || []).find((item) => item.type === "status") ||
    (attributes.data || []).find((item) => /stage|status/i.test(item.api_slug || item.title || ""));
  return {
    id: listId,
    name: list.name || listName,
    stageSlug: statusAttr?.api_slug || "stage",
  };
}

async function upsertAttioPerson(
  apiKey: string,
  listId: string,
  stageSlug: string,
  person: { email: string; name?: string },
  stage: string,
) {
  const [first = "", ...rest] = (person.name || "").split(/\s+/);
  const last = rest.join(" ");
  const created = await requestJson(
    `${ATTIO}/v2/objects/people/records?matching_attribute=email_addresses`,
    {
      method: "PUT",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [{ email_address: person.email }],
            name: [
              {
                first_name: first || person.email,
                last_name: last,
                full_name: person.name || person.email,
              },
            ],
          },
        },
      }),
    },
  );
  const recordId =
    (created as { data?: { id?: { record_id?: string } } })?.data?.id?.record_id || "";
  if (!recordId) throw new Error(`Could not upsert ${person.email}`);

  const payloads = [
    {
      parent_record_id: recordId,
      parent_object: "people",
      entry_values: stage ? { [stageSlug]: stage } : {},
    },
    {
      parent_record_id: recordId,
      parent_object: "people",
      entry_values: stage ? { [stageSlug]: [{ status: stage }] } : {},
    },
  ];
  for (const data of payloads) {
    try {
      await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
        method: "PUT",
        headers: attioHeaders(apiKey),
        body: JSON.stringify({ data }),
      });
      return;
    } catch {
      // try next shape
    }
  }
  await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
    method: "POST",
    headers: attioHeaders(apiKey),
    body: JSON.stringify({ data: payloads[0] }),
  });
}

async function syncLemlistCampaign(job: {
  userId: string;
  projectId: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
}) {
  const lemlist = await getIntegration(job.userId, job.projectId, "lemlist");
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  const campaign = await resolveLemlistCampaign(lemlist.apiKey, job.campaignName);
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  const completed = /^(ended|done|completed|archived)$/i.test(campaign.status);
  const opens = await lemlistPeople(lemlist.apiKey, campaign.id, "emailsOpened");
  const clicks = await lemlistPeople(lemlist.apiKey, campaign.id, "emailsClicked");
  const replies = await lemlistPeople(lemlist.apiKey, campaign.id, "emailsReplied");

  const byEmail = new Map<string, { email: string; name: string; stage: string }>();
  for (const person of opens) {
    byEmail.set(person.email, { ...person, stage: job.stageOpen });
  }
  for (const person of clicks) {
    byEmail.set(person.email, { ...person, stage: job.stageClick });
  }
  for (const person of replies) {
    byEmail.set(person.email, { ...person, stage: job.stageReply });
  }

  let updated = 0;
  let failed = 0;
  for (const person of byEmail.values()) {
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    completed,
    campaignStatus: campaign.status || "running",
    summary: `Synced ${updated} people to ${list.name} from ${campaign.name} (${opens.length} opens, ${clicks.length} clicks, ${replies.length} replies)${failed ? `; ${failed} failed` : ""}.`,
  };
}

async function syncBrevoCampaign(job: {
  userId: string;
  projectId: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
}) {
  const brevo = await getIntegration(job.userId, job.projectId, "brevo");
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  if (!brevo.mcpUrl) {
    throw new Error("Brevo must be connected via MCP for automatic campaign sync");
  }

  const tools = await listBrevoMcpTools(brevo.apiKey, brevo.mcpUrl || BREVO_MCP_DEFAULT);
  const campaignTool =
    tools.find((tool) => /campaign/i.test(tool.name) && /list|get|search/i.test(tool.name)) ||
    tools.find((tool) => /email.*campaign/i.test(tool.name));
  if (!campaignTool) {
    throw new Error("No Brevo MCP campaign tool found. Ask me to list Brevo MCP tools.");
  }

  const raw = await callBrevoMcpTool(
    brevo.apiKey,
    campaignTool.name,
    { name: job.campaignName, search: job.campaignName, limit: 20 },
    brevo.mcpUrl || BREVO_MCP_DEFAULT,
  );

  const lower = raw.toLowerCase();
  const completed = /"status"\s*:\s*"(sent|archived|ended|completed|suspended)"/i.test(raw);
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  const emails = [...raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) =>
    m[0].toLowerCase(),
  );
  const unique = [...new Set(emails)].slice(0, 150);
  let updated = 0;
  for (const email of unique) {
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { email }, job.stageOpen);
      updated += 1;
    } catch {
      // continue
    }
  }

  return {
    completed,
    campaignStatus: completed ? "completed" : "running",
    summary: `Brevo MCP sync for "${job.campaignName}" via ${campaignTool.name}: updated ${updated} emails into ${list.name}. Payload scan: ${unique.length} emails found.${lower.includes(job.campaignName.toLowerCase()) ? "" : " Campaign name was not clearly matched in MCP output."}`,
  };
}

function normalizeRecipe(raw: SyncRecipe | null | undefined): SyncRecipe {
  const pollPath = String(raw?.pollPath || "").trim();
  if (!pollPath) throw new Error("recipe.pollPath is required for custom connector sync");
  const method = String(raw?.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const kind = String(raw?.campaignKind || "").toLowerCase();
  return {
    pollPath,
    method,
    body: raw?.body,
    itemsPath: String(raw?.itemsPath || "").trim() || undefined,
    emailField: String(raw?.emailField || "").trim() || undefined,
    nameField: String(raw?.nameField || "").trim() || undefined,
    stageField: String(raw?.stageField || "").trim() || undefined,
    defaultStage: String(raw?.defaultStage || "").trim() || undefined,
    stageMap: raw?.stageMap,
    completedPath: String(raw?.completedPath || "").trim() || undefined,
    completedValues: (raw?.completedValues || []).map((v) => String(v).trim()).filter(Boolean),
    campaignKind: kind === "drip" || kind === "oneone" ? kind : undefined,
  };
}

async function pollCustomApi(integration: CustomIntegration, recipe: SyncRecipe) {
  const resolvedBase =
    normalizeCustomBaseUrl(integration.name, integration.baseUrl || "") || integration.baseUrl || "";
  let url = recipe.pollPath.startsWith("http")
    ? recipe.pollPath
    : `${resolvedBase.replace(/\/$/, "")}/${recipe.pollPath.replace(/^\//, "")}`;
  if (!url.startsWith("http")) {
    throw new Error(
      `Custom API "${integration.name}" needs a base URL, or recipe.pollPath must be a full URL`,
    );
  }
  if (looksLikeQueryApiKeyAuth(integration)) {
    url = withQueryApiKey(url, integration.apiKey);
  }
  const method = recipe.method || "GET";
  const init: RequestInit = {
    method,
    headers: customHeaders({
      ...integration,
      authType: resolveCustomAuthType(integration),
    }),
  };
  if (method === "POST" && recipe.body != null) {
    init.body = typeof recipe.body === "string" ? recipe.body : JSON.stringify(recipe.body);
  }
  return requestJson(url, init);
}

function extractPeopleFromRecipe(
  data: unknown,
  recipe: SyncRecipe,
  fallbackStage: string,
): { email: string; name: string; stage: string }[] {
  const root = recipe.itemsPath ? getByPath(data, recipe.itemsPath) : data;
  const items = asObjects(root);
  const people: { email: string; name: string; stage: string }[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const email = pickField(item, recipe.emailField, [
      "email",
      "email_address",
      "emailAddress",
      "leadEmail",
      "work_email",
      "primary_email",
    ])
      .toLowerCase()
      .trim();
    if (!email.includes("@")) continue;
    if (seen.has(email)) continue;
    seen.add(email);

    const name =
      pickField(item, recipe.nameField, [
        "name",
        "full_name",
        "fullName",
        "leadName",
        "firstName",
        "first_name",
      ]) ||
      [pickField(item, undefined, ["firstName", "first_name"]), pickField(item, undefined, ["lastName", "last_name"])]
        .filter(Boolean)
        .join(" ")
        .trim();

    const rawStage = pickField(item, recipe.stageField, [
      "stage",
      "status",
      "lead_status",
      "leadStatus",
      "event",
    ]);
    let stage = recipe.defaultStage || fallbackStage;
    if (rawStage) {
      const mapped = recipe.stageMap?.[rawStage] || recipe.stageMap?.[rawStage.toLowerCase()];
      stage = mapped || rawStage;
    }

    people.push({ email, name, stage });
  }
  return people;
}

function recipeCompleted(data: unknown, recipe: SyncRecipe) {
  if (!recipe.completedPath) return false;
  const value = getByPath(data, recipe.completedPath);
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return false;
  const targets = (recipe.completedValues || []).map((v) => v.toLowerCase());
  if (targets.length) return targets.includes(text);
  return /^(ended|done|completed|archived|sent|finished|closed|inactive)$/i.test(text);
}

async function syncUnifiedPortalSource(job: {
  userId: string;
  projectId: string;
  sourceIntegrationName: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
  watchAll?: boolean;
  lastSeenAt?: Date | null;
  recipe?: SyncRecipe | null;
}) {
  const integration = await getCustomIntegration(
    job.userId,
    job.projectId,
    job.sourceIntegrationName,
  );
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  if (job.watchAll || job.campaignName === "*" || /^all$/i.test(job.campaignName)) {
    const dueRounds = await driveUnifiedPortalProcessDue(integration.apiKey, integration.baseUrl, 8);
    const since = job.lastSeenAt
      ? new Date(job.lastSeenAt.getTime() - 60_000).toISOString()
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const campaigns = await listUnifiedCampaignsSince({
      apiKey: integration.apiKey,
      baseUrl: integration.baseUrl,
      updatedSince: since,
    });
    const active = campaigns.filter((item) =>
      /^(scheduled|sending|sent|paused)$/i.test(item.status),
    );

    let updated = 0;
    let failed = 0;
    let scanned = 0;
    for (const campaign of active.slice(0, 20)) {
      scanned += 1;
      const { people } = await syncUnifiedCampaignEngagement({
        apiKey: integration.apiKey,
        baseUrl: integration.baseUrl,
        campaignId: campaign.id,
        kind: campaign.kind,
        stageOpen: job.stageOpen || "open",
        stageClick: job.stageClick || "click",
        stageReply: job.stageReply || "unsubscribed",
      });
      for (const person of people.slice(0, 500)) {
        try {
          await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
          updated += 1;
        } catch {
          failed += 1;
        }
      }
    }

    return {
      completed: false,
      campaignStatus: "watching",
      lastSeenAt: new Date(),
      summary: `Unified Portal watch → ${list.name}: process-due ×${dueRounds}; scanned ${scanned} campaign(s) since ${since.slice(0, 16)}; synced ${updated} people${failed ? `; ${failed} failed` : ""}. Webhooks + updatedSince keep discovering new launches.`,
    };
  }

  // Keep portal sends moving even when nobody has the report page open.
  const dueRounds = await driveUnifiedPortalProcessDue(integration.apiKey, integration.baseUrl, 8);

  const kindHint =
    job.recipe?.campaignKind === "drip" || job.recipe?.campaignKind === "oneone"
      ? job.recipe.campaignKind
      : undefined;
  const campaign = await resolveUnifiedPortalCampaign(
    integration.apiKey,
    integration.baseUrl,
    job.campaignName,
    kindHint,
  );

  const { people, counts } = await collectUnifiedPortalPeople({
    apiKey: integration.apiKey,
    baseUrl: integration.baseUrl,
    campaignId: campaign.id,
    kind: campaign.kind,
    stageOpen: job.stageOpen || "open",
    stageClick: job.stageClick || "click",
    stageReply: job.stageReply || "unsubscribed",
  });

  let updated = 0;
  let failed = 0;
  for (const person of people.slice(0, 500)) {
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  const completed = campaign.status === "sent";
  return {
    completed,
    campaignStatus: campaign.status || "running",
    summary: `Unified Portal · ${campaign.name} (${campaign.kind}): process-due ×${dueRounds}; synced ${updated} to ${list.name} (${counts.opens} opens, ${counts.clicks} clicks, ${counts.unsubscribed} unsubs)${failed ? `; ${failed} failed` : ""}. Status: ${campaign.status || "unknown"}.`,
  };
}

async function syncOutreachSource(job: {
  userId: string;
  projectId: string;
  sourceIntegrationName: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
}) {
  const integration = await getCustomIntegration(
    job.userId,
    job.projectId,
    job.sourceIntegrationName,
  );
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  const campaign = await resolveOutreachCampaign(
    integration.apiKey,
    integration.baseUrl,
    job.campaignName,
  );

  const { people, counts } = await collectOutreachPeople({
    apiKey: integration.apiKey,
    baseUrl: integration.baseUrl,
    campaignId: campaign.id,
    stageOpen: job.stageOpen || "open",
    stageClick: job.stageClick || "click",
    stageReply: job.stageReply || "bounced",
  });

  let updated = 0;
  let failed = 0;
  for (const person of people.slice(0, 500)) {
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  const completed = /^(completed|paused|auto_paused)$/i.test(campaign.status);
  // Only auto-stop on completed — paused jobs stay running so resume keeps syncing.
  const done = campaign.status === "completed";
  return {
    completed: done,
    campaignStatus: campaign.status || "running",
    summary: `Outreach 1-1 · ${campaign.name}: synced ${updated} to ${list.name} (${counts.opens} opens, ${counts.clicks} clicks, ${counts.bounced} bounces)${failed ? `; ${failed} failed` : ""}. Status: ${campaign.status || "unknown"}${completed && !done ? " (still syncing while paused)" : ""}.`,
  };
}

async function syncRecipeSource(job: {
  userId: string;
  projectId: string;
  sourceIntegrationName: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick?: string;
  stageReply?: string;
  watchAll?: boolean;
  lastSeenAt?: Date | null;
  recipe: SyncRecipe | null | undefined;
}) {
  const integration = await getCustomIntegration(
    job.userId,
    job.projectId,
    job.sourceIntegrationName,
  );

  if (isUnifiedPortal(integration)) {
    return syncUnifiedPortalSource({
      userId: job.userId,
      projectId: job.projectId,
      sourceIntegrationName: job.sourceIntegrationName,
      campaignName: job.campaignName,
      attioList: job.attioList,
      stageOpen: job.stageOpen,
      stageClick: job.stageClick || "click",
      stageReply: job.stageReply || "unsubscribed",
      watchAll: job.watchAll || job.recipe?.watchAll,
      lastSeenAt: job.lastSeenAt,
      recipe: job.recipe,
    });
  }

  if (isNexusesOutreach(integration)) {
    return syncOutreachSource({
      userId: job.userId,
      projectId: job.projectId,
      sourceIntegrationName: job.sourceIntegrationName,
      campaignName: job.campaignName,
      attioList: job.attioList,
      stageOpen: job.stageOpen,
      stageClick: job.stageClick || "click",
      stageReply: job.stageReply || "bounced",
    });
  }

  if (isSmartLead(integration)) {
    return {
      completed: false,
      campaignStatus: "listening",
      summary: `SmartLead → Attio “${job.attioList}”: listening for webhooks (EMAIL_SENT / EMAIL_OPEN / EMAIL_LINK_CLICK / EMAIL_REPLY). API polling does not provide reliable open/click/sent — keep the webhook URL active.`,
    };
  }

  const recipe = normalizeRecipe(job.recipe);
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  const data = await pollCustomApi(integration, recipe);
  const people = extractPeopleFromRecipe(data, recipe, job.stageOpen || "open").slice(0, 500);
  const completed = recipeCompleted(data, recipe);

  let updated = 0;
  let failed = 0;
  for (const person of people) {
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    completed,
    campaignStatus: completed ? "completed" : "running",
    summary: `Synced ${updated} people to ${list.name} from ${integration.name} · ${job.campaignName} (polled ${recipe.pollPath}; ${people.length} emails found)${failed ? `; ${failed} failed` : ""}${completed ? "" : ". Will keep polling until you stop it (or completion rule matches)."}`,
  };
}

export async function runAutomationById(automationId: string) {
  await dbConnect();
  const job = await Automation.findById(automationId);
  if (!job || job.status !== "running") return null;

  try {
    let result: {
      completed: boolean;
      campaignStatus: string;
      summary: string;
      lastSeenAt?: Date;
    };
    if (job.sourceProvider === "lemlist") {
      result = await syncLemlistCampaign({
        userId: String(job.userId),
        projectId: String(job.projectId),
        campaignName: job.campaignName,
        attioList: job.attioList,
        stageOpen: job.stageOpen,
        stageClick: job.stageClick,
        stageReply: job.stageReply,
      });
    } else if (job.sourceProvider === "brevo") {
      result = await syncBrevoCampaign({
        userId: String(job.userId),
        projectId: String(job.projectId),
        campaignName: job.campaignName,
        attioList: job.attioList,
        stageOpen: job.stageOpen,
        stageClick: job.stageClick,
        stageReply: job.stageReply,
      });
    } else {
      result = await syncRecipeSource({
        userId: String(job.userId),
        projectId: String(job.projectId),
        sourceIntegrationName: job.sourceIntegrationName || job.campaignName,
        campaignName: job.campaignName,
        attioList: job.attioList,
        stageOpen: job.stageOpen,
        stageClick: job.stageClick,
        stageReply: job.stageReply,
        watchAll: Boolean(job.watchAll),
        lastSeenAt: job.lastSeenAt || null,
        recipe: job.recipe as SyncRecipe | undefined,
      });
    }

    job.lastRunAt = new Date();
    job.runCount = (job.runCount || 0) + 1;
    job.lastSummary = result.summary;
    job.error = "";
    if ("lastSeenAt" in result && result.lastSeenAt instanceof Date) {
      job.lastSeenAt = result.lastSeenAt;
    }
    if (result.completed && !job.watchAll) {
      job.status = "completed";
      job.lastSummary = `${result.summary} Source is complete — automatic updates stopped.`;
    } else {
      job.nextRunAt = new Date(Date.now() + Math.max(1, job.intervalMinutes || 2) * 60_000);
    }
    await job.save();
    return serializeAutomation(job);
  } catch (err) {
    job.lastRunAt = new Date();
    job.error = err instanceof Error ? err.message : "Sync failed";
    job.lastSummary = `Sync failed: ${job.error}`;
    job.nextRunAt = new Date(Date.now() + Math.max(1, job.intervalMinutes || 2) * 60_000);
    await job.save();
    return serializeAutomation(job);
  }
}

export async function processDueAutomations(limit = 5) {
  await dbConnect();
  const due = await Automation.find({
    status: "running",
    nextRunAt: { $lte: new Date() },
  })
    .sort({ nextRunAt: 1 })
    .limit(limit);

  const results: AutomationDTO[] = [];
  for (const job of due) {
    const updated = await runAutomationById(String(job._id));
    if (updated) results.push(updated);
  }
  return results;
}

export function ensureAutomationRunner() {
  const g = globalThis as unknown as { __nexusesAutomationTimer?: NodeJS.Timeout };
  if (g.__nexusesAutomationTimer) return;
  g.__nexusesAutomationTimer = setInterval(() => {
    void processDueAutomations().catch(() => {
      // keep runner alive
    });
    void import("@/lib/chat-jobs")
      .then((mod) => mod.processDueChatJobs())
      .catch(() => undefined);
  }, 30_000);
  void processDueAutomations().catch(() => undefined);
  void import("@/lib/chat-jobs")
    .then((mod) => {
      mod.ensureChatJobRunner();
      return mod.processDueChatJobs();
    })
    .catch(() => undefined);
}

export async function startCampaignAutomation(input: {
  userId: string;
  projectId: string;
  sourceProvider: AutomationSourceProvider;
  sourceIntegrationName?: string;
  campaignName: string;
  attioList: string;
  stageOpen?: string;
  stageClick?: string;
  stageReply?: string;
  intervalMinutes?: number;
  recipe?: SyncRecipe | null;
  watchAll?: boolean;
}) {
  await dbConnect();
  ensureAutomationRunner();

  // Ensure Attio is connected for all sync jobs.
  await getIntegration(input.userId, input.projectId, "attio");

  let sourceProvider = input.sourceProvider;
  let sourceIntegrationName = String(input.sourceIntegrationName || "").trim();
  let recipe: SyncRecipe | undefined;
  let watchAll = Boolean(input.watchAll || input.recipe?.watchAll);
  const campaignNameRaw = String(input.campaignName || "").trim();
  if (campaignNameRaw === "*" || /^all$/i.test(campaignNameRaw)) watchAll = true;

  if (sourceProvider === "lemlist") {
    await getIntegration(input.userId, input.projectId, "lemlist");
  } else if (sourceProvider === "brevo") {
    await getIntegration(input.userId, input.projectId, "brevo");
  } else {
    sourceProvider = "other";
    if (!sourceIntegrationName) {
      throw new Error("integration name is required for custom connector sync");
    }
    const custom = await getCustomIntegration(input.userId, input.projectId, sourceIntegrationName);
    sourceIntegrationName = custom.name;
    if (isUnifiedPortal(custom)) {
      const kind = String(input.recipe?.campaignKind || "").toLowerCase();
      recipe = {
        pollPath: watchAll ? "/api/campaigns" : "/api/campaigns/process-due",
        method: watchAll ? "GET" : "POST",
        campaignKind: kind === "drip" || kind === "oneone" ? kind : undefined,
        watchAll,
      };
    } else if (isNexusesOutreach(custom)) {
      if (watchAll) {
        throw new Error(
          "Watch-all mode is only supported for Unified Portal and SmartLead. Pass a specific Outreach campaign name.",
        );
      }
      recipe = {
        pollPath: "/api/v1/campaigns",
        method: "GET",
      };
    } else if (isSmartLead(custom)) {
      recipe = {
        pollPath: "/campaigns",
        method: "GET",
        watchAll,
      };
    } else {
      if (watchAll) {
        throw new Error("watch_all requires Unified Portal or SmartLead");
      }
      recipe = normalizeRecipe(input.recipe);
    }
  }

  const campaignName = watchAll ? "*" : campaignNameRaw;
  if (!campaignName) throw new Error("Campaign name is required");

  const label =
    sourceProvider === "other" ? sourceIntegrationName || "custom API" : sourceProvider;
  const title = watchAll
    ? isSmartLead({ name: sourceIntegrationName })
      ? `Watch SmartLead → Attio “${input.attioList}”`
      : `Watch Unified Portal → Attio “${input.attioList}”`
    : `Auto-update Attio from ${label} · ${campaignName}`;

  const existing = await Automation.findOne({
    userId: input.userId,
    projectId: input.projectId,
    type: "campaign_to_attio",
    sourceProvider,
    sourceIntegrationName: sourceProvider === "other" ? sourceIntegrationName : "",
    campaignName,
    attioList: input.attioList,
    status: "running",
  });
  if (existing) {
    const existingDto = serializeAutomation(existing);
    if (existing.webhookToken && isSmartLead({ name: existing.sourceIntegrationName })) {
      return {
        ...existingDto,
        lastSummary: `${existingDto.lastSummary || ""} Webhook URL: ${smartleadWebhookPublicUrl(existing.webhookToken)}`.trim(),
      };
    }
    return existingDto;
  }

  const defaultInterval =
    sourceProvider === "other" &&
    (isUnifiedPortal({ name: sourceIntegrationName }) ||
      isNexusesOutreach({ name: sourceIntegrationName }) ||
      isSmartLead({ name: sourceIntegrationName }))
      ? 1
      : 2;

  let webhookToken = "";
  let webhookSecret = "";
  let portalWebhookId = "";
  let webhookNote = "";
  let smartleadWebhookUrl = "";

  if (watchAll && isUnifiedPortal({ name: sourceIntegrationName })) {
    const custom = await getCustomIntegration(input.userId, input.projectId, sourceIntegrationName);
    webhookToken = makeWebhookReceiveToken();
    try {
      const registered = await registerUnifiedPortalWebhook({
        apiKey: custom.apiKey,
        baseUrl: custom.baseUrl,
        receiveToken: webhookToken,
      });
      webhookSecret = registered.secret;
      portalWebhookId = registered.portalWebhookId;
      webhookNote = ` Webhook registered at ${registered.url}.`;
    } catch (err) {
      webhookToken = "";
      webhookNote = ` Webhook skipped: ${err instanceof Error ? err.message : "could not register"}. Polling updatedSince still runs.`;
    }
  } else if (isSmartLead({ name: sourceIntegrationName })) {
    // SmartLead API often lacks open/click/sent — webhooks are the source of truth.
    const custom = await getCustomIntegration(input.userId, input.projectId, sourceIntegrationName);
    webhookToken = makeWebhookReceiveToken();
    smartleadWebhookUrl = smartleadWebhookPublicUrl(webhookToken);
    try {
      await registerSmartleadWebhook({
        apiKey: custom.apiKey,
        baseUrl: custom.baseUrl,
        webhookUrl: smartleadWebhookUrl,
        name: `Nexuses · ${input.attioList}`,
        campaignId: watchAll ? undefined : undefined,
      });
      webhookNote = ` Paste this URL in SmartLead webhooks if not auto-saved: ${smartleadWebhookUrl}`;
    } catch (err) {
      webhookNote = ` Paste this webhook URL in SmartLead (API register failed: ${err instanceof Error ? err.message.slice(0, 120) : "error"}): ${smartleadWebhookUrl}`;
    }
  }

  const job = await Automation.create({
    userId: input.userId,
    projectId: input.projectId,
    type: "campaign_to_attio",
    status: "running",
    title,
    sourceProvider,
    sourceIntegrationName: sourceProvider === "other" ? sourceIntegrationName : "",
    campaignName,
    attioList: input.attioList.trim(),
    stageOpen: input.stageOpen || "open",
    stageClick: input.stageClick || "click",
    stageReply: input.stageReply || "hot",
    intervalMinutes: Math.min(
      Math.max(input.intervalMinutes || defaultInterval, 1),
      60,
    ),
    recipe: sourceProvider === "other" ? recipe : undefined,
    watchAll,
    lastSeenAt: watchAll ? new Date() : undefined,
    webhookToken,
    webhookSecret,
    portalWebhookId,
    nextRunAt: new Date(),
  });

  const first = await runAutomationById(String(job._id));
  const serialized = first || serializeAutomation(job);
  if (webhookNote) {
    return { ...serialized, lastSummary: `${serialized.lastSummary || ""}${webhookNote}`.trim() };
  }
  return serialized;
}

export async function stopAutomation(input: {
  userId: string;
  projectId: string;
  automationId?: string;
  campaignName?: string;
}) {
  await dbConnect();
  const filter: Record<string, unknown> = {
    userId: input.userId,
    projectId: input.projectId,
    status: "running",
  };
  if (input.automationId) filter._id = input.automationId;
  if (input.campaignName) {
    filter.campaignName = new RegExp(
      `^${input.campaignName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    );
  }
  const job = await Automation.findOne(filter);
  if (!job) throw new Error("No running automation found to stop");

  if (job.portalWebhookId && job.sourceIntegrationName) {
    try {
      const custom = await getCustomIntegration(
        String(job.userId),
        String(job.projectId),
        job.sourceIntegrationName,
      );
      await deleteUnifiedPortalWebhook({
        apiKey: custom.apiKey,
        baseUrl: custom.baseUrl,
        portalWebhookId: job.portalWebhookId,
      });
    } catch {
      // continue stopping even if revoke fails
    }
  }

  job.status = "stopped";
  job.lastSummary = "Stopped by user. Automatic updates are no longer running.";
  job.webhookToken = "";
  job.webhookSecret = "";
  job.portalWebhookId = "";
  await job.save();
  return serializeAutomation(job);
}

/** Apply a verified Unified Portal webhook to matching watch/campaign jobs. */
export async function handleUnifiedWebhookToken(input: {
  token: string;
  rawBody: string;
  signatureHeader: string | null;
}) {
  await dbConnect();
  const job = await Automation.findOne({
    webhookToken: input.token,
    status: "running",
  });
  if (!job?.webhookSecret) return { ok: false, error: "Unknown webhook" as const };

  const { verifyUnifiedWebhookSignature, peopleFromUnifiedWebhookEvent } = await import(
    "@/lib/unified-webhooks"
  );
  if (
    !verifyUnifiedWebhookSignature({
      rawBody: input.rawBody,
      signatureHeader: input.signatureHeader,
      secret: job.webhookSecret,
    })
  ) {
    return { ok: false, error: "Invalid signature" as const };
  }

  let payload: import("@/lib/unified-webhooks").UnifiedWebhookPayload = {};
  try {
    payload = JSON.parse(input.rawBody) as import("@/lib/unified-webhooks").UnifiedWebhookPayload;
  } catch {
    return { ok: false, error: "Invalid JSON" as const };
  }

  const type = String(payload.type || "").toLowerCase();
  const attio = await getIntegration(String(job.userId), String(job.projectId), "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);
  const integration = await getCustomIntegration(
    String(job.userId),
    String(job.projectId),
    job.sourceIntegrationName,
  );

  let updated = 0;
  if (type === "send.opened" || type === "send.clicked") {
    const people = peopleFromUnifiedWebhookEvent(payload, {
      open: job.stageOpen || "open",
      click: job.stageClick || "click",
    });
    for (const person of people) {
      try {
        await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
        updated += 1;
      } catch {
        // continue
      }
    }
  } else if (type === "campaign.created" || type === "campaign.launched") {
    const campaignId = String(payload.data?.campaignId || "").trim();
    const kind = String(payload.data?.kind || "drip").toLowerCase() === "oneone" ? "oneone" : "drip";
    if (campaignId) {
      const { people } = await syncUnifiedCampaignEngagement({
        apiKey: integration.apiKey,
        baseUrl: integration.baseUrl,
        campaignId,
        kind,
        stageOpen: job.stageOpen || "open",
        stageClick: job.stageClick || "click",
        stageReply: job.stageReply || "unsubscribed",
      });
      for (const person of people.slice(0, 500)) {
        try {
          await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, person, person.stage);
          updated += 1;
        } catch {
          // continue
        }
      }
    } else {
      await driveUnifiedPortalProcessDue(integration.apiKey, integration.baseUrl, 4);
    }
  }

  job.lastRunAt = new Date();
  job.lastSummary = `Webhook ${type || "event"}: updated ${updated} in Attio “${list.name}”.`;
  job.error = "";
  await job.save();
  return { ok: true as const, updated, type };
}

/** SmartLead webhooks (token in URL; no HMAC). Maps sent/open/click/reply → Attio. */
export async function handleSmartleadWebhookToken(input: {
  token: string;
  rawBody: string;
}) {
  await dbConnect();
  const job = await Automation.findOne({
    webhookToken: input.token,
    status: "running",
  });
  if (!job) return { ok: false, error: "Unknown webhook" as const };

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(input.rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Invalid JSON" as const };
  }

  const normalized = normalizeSmartleadEvent(payload);
  const stage = stageFromSmartleadEvent(normalized.rawType, {
    open: job.stageOpen || "open",
    click: job.stageClick || "click",
    reply: job.stageReply || "hot",
    sent: "sent",
  });

  if (!stage) {
    return { ok: true as const, updated: 0, type: normalized.rawType || "ignored" };
  }

  if (!normalized.email.includes("@")) {
    return { ok: false, error: "Missing email in payload" as const };
  }

  // Single-campaign jobs only accept matching campaign names (watch-all accepts all).
  if (!job.watchAll && job.campaignName && job.campaignName !== "*") {
    const wanted = job.campaignName.toLowerCase();
    const got = normalized.campaignName.toLowerCase();
    if (got && got !== wanted && !got.includes(wanted) && !wanted.includes(got)) {
      return { ok: true as const, updated: 0, type: normalized.rawType, skipped: "campaign mismatch" };
    }
  }

  const attio = await getIntegration(String(job.userId), String(job.projectId), "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);
  try {
    await upsertAttioPerson(
      attio.apiKey,
      list.id,
      list.stageSlug,
      { email: normalized.email, name: normalized.name },
      stage,
    );
  } catch (err) {
    job.lastRunAt = new Date();
    job.error = err instanceof Error ? err.message : "Attio upsert failed";
    await job.save();
    return { ok: false, error: job.error };
  }

  job.lastRunAt = new Date();
  job.lastSummary = `SmartLead ${normalized.rawType || "event"}: ${normalized.email} → ${stage} in “${list.name}”${normalized.campaignName ? ` (${normalized.campaignName})` : ""}.`;
  job.error = "";
  await job.save();
  return { ok: true as const, updated: 1, type: normalized.rawType };
}

export async function listAutomations(userId: string, projectId: string) {
  await dbConnect();
  ensureAutomationRunner();
  await processDueAutomations(3);
  const docs = await Automation.find({ userId, projectId })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean();
  return docs.map(serializeAutomation);
}
