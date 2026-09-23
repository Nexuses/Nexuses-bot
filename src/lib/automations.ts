import { attioNameValues } from "@/lib/attio-person-fields";
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
  restApiKey?: string;
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

async function requestJson(url: string, init: RequestInit, retries = 6) {
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch(url, {
        ...init,
        cache: "no-store",
        signal: init.signal || controller.signal,
      });
      const text = await res.text();
      if (res.status === 429 || res.status === 503) {
        lastError = `${res.status} ${res.statusText}: ${text.slice(0, 400)}`;
        const retryAfterRaw = res.headers.get("retry-after");
        const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
        const waitMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(60_000, retryAfterSec * 1000)
            : Math.min(30_000, 1000 * 2 ** attempt);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        lastError = `Request timed out: ${url}`;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        throw new Error(lastError);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || `Request failed: ${url}`);
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
  return { apiKey: doc.apiKey, mcpUrl: doc.mcpUrl || "", restApiKey: doc.restApiKey || "" };
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

async function listExistingStageTitles(
  apiKey: string,
  listId: string,
  stageSlug: string,
): Promise<string[]> {
  try {
    const data = (await requestJson(
      `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageSlug)}/statuses`,
      { headers: attioHeaders(apiKey) },
    )) as { data?: Array<{ title?: string; status?: { title?: string } }> };
    return (data.data || [])
      .map((item) => String(item.title || item.status?.title || "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Prefer existing Attio stage titles case-insensitively (Open == open).
 * Only create a stage when no case-insensitive match exists.
 * Returns map: desiredLower -> exact Attio title to write.
 */
async function ensureListStages(
  apiKey: string,
  listId: string,
  stageSlug: string,
  stages: string[],
): Promise<Map<string, string>> {
  const existing = await listExistingStageTitles(apiKey, listId, stageSlug);
  const canonical = new Map<string, string>();

  for (const stage of stages) {
    const desired = String(stage || "").trim();
    if (!desired) continue;
    const key = desired.toLowerCase();
    const match = existing.find((title) => title.toLowerCase() === key);
    if (match) {
      canonical.set(key, match);
      continue;
    }
    try {
      await requestJson(
        `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageSlug)}/statuses`,
        {
          method: "POST",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({ data: { title: desired } }),
        },
      );
      existing.push(desired);
      canonical.set(key, desired);
    } catch {
      // Race / already exists — re-read once
      const refreshed = await listExistingStageTitles(apiKey, listId, stageSlug);
      const again = refreshed.find((title) => title.toLowerCase() === key);
      canonical.set(key, again || desired);
      for (const title of refreshed) {
        if (!existing.some((e) => e.toLowerCase() === title.toLowerCase())) {
          existing.push(title);
        }
      }
    }
  }
  return canonical;
}

function resolveStageTitle(canonical: Map<string, string>, stage: string) {
  const desired = String(stage || "").trim();
  if (!desired) return "";
  return canonical.get(desired.toLowerCase()) || desired;
}

function formatWhen(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function buildCampaignNotes(input: {
  campaignName: string;
  subject?: string;
  stage: string;
  sentAt?: string;
  openedAt?: string;
  clickedAt?: string;
}) {
  const campaign = input.campaignName;
  const subject = input.subject ? `Subject: ${input.subject}` : "";
  const stageLower = input.stage.toLowerCase();
  const isOpen = Boolean(input.openedAt) || /open/.test(stageLower);
  const isClick = Boolean(input.clickedAt) || /click/.test(stageLower);
  const notes: Array<{ title: string; content: string; kind: "sent" | "opened" | "clicked" }> =
    [];

  // 1) Campaign / sent details — once per campaign
  notes.push({
    kind: "sent",
    title: `Sent · ${campaign}`.slice(0, 200),
    content: [
      `Campaign: ${campaign}`,
      subject,
      input.sentAt
        ? `Sent to this contact: ${formatWhen(input.sentAt)}`
        : "Sent to this contact (synced from campaign).",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  // 2) Open note — only if they opened
  if (isOpen) {
    notes.push({
      kind: "opened",
      title: `Opened · ${campaign}`.slice(0, 200),
      content: [
        `Campaign: ${campaign}`,
        subject,
        input.openedAt
          ? `Contact opened the email: ${formatWhen(input.openedAt)}`
          : "Contact opened the email (synced from campaign).",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  // 3) Click note — only if they clicked
  if (isClick) {
    notes.push({
      kind: "clicked",
      title: `Clicked · ${campaign}`.slice(0, 200),
      content: [
        `Campaign: ${campaign}`,
        subject,
        input.clickedAt
          ? `Contact clicked a link: ${formatWhen(input.clickedAt)}`
          : "Contact clicked a link (synced from campaign).",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  return notes;
}

type ExistingNotes = {
  titles: Set<string>;
  bodies: string[];
  ok: boolean;
};

async function listPersonNotes(apiKey: string, recordId: string): Promise<ExistingNotes> {
  try {
    const data = (await requestJson(
      `${ATTIO}/v2/notes?parent_object=people&parent_record_id=${encodeURIComponent(recordId)}&limit=50`,
      { headers: attioHeaders(apiKey) },
    )) as {
      data?: Array<{ title?: string; content_plaintext?: string }>;
    };
    const rows = data.data || [];
    return {
      ok: true,
      titles: new Set(
        rows.map((item) => String(item.title || "").trim().toLowerCase()).filter(Boolean),
      ),
      bodies: rows.map((item) => String(item.content_plaintext || "").toLowerCase()),
    };
  } catch {
    // If we cannot read notes, do NOT create more (avoids duplicate spam).
    return { ok: false, titles: new Set(), bodies: [] };
  }
}

function campaignNoteAlreadyExists(
  existing: ExistingNotes,
  campaignName: string,
  kind: "sent" | "opened" | "clicked",
  title: string,
) {
  const titleKey = title.trim().toLowerCase();
  if (existing.titles.has(titleKey)) return true;

  const campaign = campaignName.trim().toLowerCase();
  if (!campaign) return false;

  for (const t of existing.titles) {
    if (!t.includes(campaign)) continue;
    if (kind === "sent" && (t.startsWith("sent") || t.startsWith("campaign:"))) return true;
    if (kind === "opened" && t.startsWith("opened")) return true;
    if (kind === "clicked" && t.startsWith("clicked")) return true;
  }

  for (const body of existing.bodies) {
    if (!body.includes(campaign)) continue;
    // Old combined notes ended with "Synced by Nexuses · …" — treat as already written.
    if (kind === "sent" && (body.includes("synced by nexuses") || body.includes("sent to"))) {
      return true;
    }
    if (kind === "opened" && (body.includes("opened:") || body.includes("opened the email"))) {
      return true;
    }
    if (kind === "clicked" && (body.includes("clicked:") || body.includes("clicked a link"))) {
      return true;
    }
  }
  return false;
}

async function createAttioNote(
  apiKey: string,
  recordId: string,
  note: { title: string; content: string },
) {
  await requestJson(`${ATTIO}/v2/notes`, {
    method: "POST",
    headers: attioHeaders(apiKey),
    body: JSON.stringify({
      data: {
        parent_object: "people",
        parent_record_id: recordId,
        title: note.title.slice(0, 200),
        format: "plaintext",
        content: note.content.slice(0, 8000),
      },
    }),
  });
}

/** Create Sent / Opened / Clicked notes only when missing — never re-add on every sync. */
async function ensureCampaignNotes(
  apiKey: string,
  recordId: string,
  campaignName: string,
  notes: Array<{ title: string; content: string; kind: "sent" | "opened" | "clicked" }>,
) {
  if (!notes.length) return 0;
  const existing = await listPersonNotes(apiKey, recordId);
  if (!existing.ok) return 0;

  let created = 0;
  for (const note of notes) {
    if (campaignNoteAlreadyExists(existing, campaignName, note.kind, note.title)) continue;
    try {
      await createAttioNote(apiKey, recordId, note);
      existing.titles.add(note.title.trim().toLowerCase());
      existing.bodies.push(note.content.toLowerCase());
      created += 1;
    } catch {
      // Notes require note:read-write — don't fail the whole sync
    }
  }
  return created;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

async function upsertAttioPerson(
  apiKey: string,
  listId: string,
  stageSlug: string,
  person: {
    email: string;
    name?: string;
    stage: string;
    campaignName?: string;
    notes?: Array<{
      title: string;
      content: string;
      kind: "sent" | "opened" | "clicked";
    }> | null;
  },
) {
  const created = await requestJson(
    `${ATTIO}/v2/objects/people/records?matching_attribute=email_addresses`,
    {
      method: "PUT",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [{ email_address: person.email }],
            ...attioNameValues(person.name),
          },
        },
      }),
    },
  );
  const recordId =
    (created as { data?: { id?: { record_id?: string } } })?.data?.id?.record_id || "";
  if (!recordId) throw new Error(`Could not upsert ${person.email}`);

  const stage = String(person.stage || "").trim();
  if (stage) {
    const payloads = [
      {
        parent_record_id: recordId,
        parent_object: "people",
        entry_values: { [stageSlug]: stage },
      },
      {
        parent_record_id: recordId,
        parent_object: "people",
        entry_values: { [stageSlug]: [{ status: stage }] },
      },
    ];
    let listed = false;
    for (const data of payloads) {
      try {
        await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
          method: "PUT",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({ data }),
        });
        listed = true;
        break;
      } catch {
        // try next shape
      }
    }
    if (!listed) {
      await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
        method: "POST",
        headers: attioHeaders(apiKey),
        body: JSON.stringify({ data: payloads[0] }),
      });
    }
  }

  if (person.notes?.length) {
    await ensureCampaignNotes(
      apiKey,
      recordId,
      person.campaignName || "",
      person.notes,
    );
  }
  return recordId;
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
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { email, stage: job.stageOpen });
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
  oneShot?: boolean;
  realEngagement?: boolean;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
}) {
  const integration = await getCustomIntegration(
    job.userId,
    job.projectId,
    job.sourceIntegrationName,
  );
  const attio = await getIntegration(job.userId, job.projectId, "attio");
  const list = await resolveAttioList(attio.apiKey, job.attioList);
  const stageOpen = job.stageOpen || "Open";
  const stageClick = job.stageClick || "Click";
  const stageProspect = "Prospect";

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
        stageOpen,
        stageClick,
        stageReply: job.stageReply || "unsubscribed",
      });
      for (const person of people.slice(0, 500)) {
        try {
          await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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

  // Live automations keep portal sends moving; one-shot completed syncs skip this (it often hangs).
  let dueRounds = 0;
  if (!job.oneShot) {
    await job.onStatus?.(`Driving Unified Portal process-due…`);
    dueRounds = await driveUnifiedPortalProcessDue(integration.apiKey, integration.baseUrl, 8);
  }

  const kindHint =
    job.recipe?.campaignKind === "drip" || job.recipe?.campaignKind === "oneone"
      ? job.recipe.campaignKind
      : undefined;
  await job.onStatus?.(`Lookup “${job.campaignName}”…`);
  const campaign = await resolveUnifiedPortalCampaign(
    integration.apiKey,
    integration.baseUrl,
    job.campaignName,
    kindHint,
  );

  await job.onStatus?.(`Stages on “${list.name}”…`);
  const stageMap = await ensureListStages(attio.apiKey, list.id, list.stageSlug, [
    stageProspect,
    stageOpen,
    stageClick,
  ]);
  const prospectTitle = resolveStageTitle(stageMap, stageProspect);
  const openTitle = resolveStageTitle(stageMap, stageOpen);
  const clickTitle = resolveStageTitle(stageMap, stageClick);

  await job.onStatus?.(`Fetch recipients · ${campaign.name}…`);
  const { people, counts } = await collectUnifiedPortalPeople({
    apiKey: integration.apiKey,
    baseUrl: integration.baseUrl,
    campaignId: campaign.id,
    kind: campaign.kind,
    stageProspect: prospectTitle,
    stageOpen: openTitle,
    stageClick: clickTitle,
    stageReply: job.stageReply || "unsubscribed",
    realEngagement: Boolean(job.realEngagement),
  });

  if (!people.length) {
    return {
      completed: campaignLooksCompleted(campaign.status),
      campaignStatus: campaign.status || "running",
      summary: `Unified Portal · ${campaign.name}: no recipients returned (delivered ${counts.delivered}, opens ${counts.opens}, clicks ${counts.clicks}). Nothing written to Attio.`,
    };
  }

  let updated = 0;
  let failed = 0;
  let notesWritten = 0;
  let firstError = "";
  const batch = people.slice(0, job.oneShot ? 8000 : 5000);
  await job.onStatus?.(`Writing to Attio…`, 0, batch.length);

  const subject = String(campaign.subject || "").trim();
  await mapPool(batch, job.oneShot ? 4 : 3, async (person) => {
    const stage = resolveStageTitle(stageMap, person.stage) || person.stage;
    const notes = buildCampaignNotes({
      campaignName: campaign.name,
      subject,
      stage,
      sentAt: person.sentAt,
      openedAt: person.openedAt,
      clickedAt: person.clickedAt,
    });
    try {
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, {
        email: person.email,
        name: person.name,
        stage,
        campaignName: campaign.name,
        notes,
      });
      updated += 1;
      notesWritten += 1;
    } catch (err) {
      failed += 1;
      if (!firstError) {
        firstError = err instanceof Error ? err.message : "Attio write failed";
      }
    }
    const done = updated + failed;
    if (done % 25 === 0 || done === batch.length) {
      await job.onStatus?.(`Writing to Attio…`, done, batch.length);
    }
  });

  const completed = campaignLooksCompleted(campaign.status);
  return {
    completed,
    campaignStatus: campaign.status || "running",
    summary: `Unified Portal · ${campaign.name}: synced **${updated}** → **${list.name}** (notes: Sent / Opened / Clicked, no duplicates${job.realEngagement ? "; real opens/clicks ≥45s after send" : ""})${failed ? `; ${failed} failed` : ""}${firstError ? `. ${firstError}` : ""}`,
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
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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
  oneShot?: boolean;
  realEngagement?: boolean;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
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
      stageClick: job.stageClick || "Click",
      stageReply: job.stageReply || "unsubscribed",
      watchAll: job.watchAll || job.recipe?.watchAll,
      lastSeenAt: job.lastSeenAt,
      recipe: job.recipe,
      oneShot: job.oneShot,
      realEngagement: job.realEngagement,
      onStatus: job.onStatus,
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
      await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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
        realEngagement: Boolean(job.realEngagement),
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

export function campaignLooksCompleted(status: string) {
  return /^(ended|done|completed|archived|sent|finished|closed|inactive)$/i.test(
    String(status || "").trim(),
  );
}

export function campaignLooksRunning(status: string) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return true;
  if (campaignLooksCompleted(s)) return false;
  return /^(scheduled|sending|running|active|paused|auto_paused|in[_ -]?progress|live|draft)$/i.test(
    s,
  )
    ? true
    : !campaignLooksCompleted(s);
}

/** One-shot sync (not a live automation). Used for completed campaigns / background chat jobs. */
export async function syncCampaignToAttioOnce(input: {
  userId: string;
  projectId: string;
  sourceProvider: "lemlist" | "brevo" | "other";
  sourceIntegrationName?: string;
  campaignName: string;
  attioList: string;
  stageOpen?: string;
  stageClick?: string;
  stageReply?: string;
  realEngagement?: boolean;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
}) {
  const stageOpen = input.stageOpen || "Open";
  const stageClick = input.stageClick || "Click";
  const stageReply = input.stageReply || "Open";
  await input.onStatus?.(
    `One-time sync · ${input.campaignName} → ${input.attioList}`,
  );

  if (input.sourceProvider === "lemlist") {
    return syncLemlistCampaign({
      userId: input.userId,
      projectId: input.projectId,
      campaignName: input.campaignName,
      attioList: input.attioList,
      stageOpen,
      stageClick,
      stageReply,
    });
  }
  if (input.sourceProvider === "brevo") {
    // Prefer full Brevo export path for richer Prospect/Open/Click coverage.
    const [attio, brevo] = await Promise.all([
      getIntegration(input.userId, input.projectId, "attio"),
      getIntegration(input.userId, input.projectId, "brevo"),
    ]);
    const { importBrevoCampaignsToAttio } = await import("@/lib/brevo-attio-import");
    const result = await importBrevoCampaignsToAttio({
      attioApiKey: attio.apiKey,
      brevoApiKey: brevo.apiKey,
      brevoRestApiKey: brevo.restApiKey || undefined,
      brevoMcpUrl: brevo.mcpUrl || undefined,
      campaigns: [input.campaignName],
      attioList: input.attioList,
      stageProspect: "Prospect",
      stageOpen,
      stageClick,
      onStatus: input.onStatus,
    });
    return {
      completed: true,
      campaignStatus: "completed",
      summary: `Brevo → Attio “${result.list}”: imported ${result.imported} contacts (Prospect/Open/Click).`,
    };
  }

  const integrationName = String(input.sourceIntegrationName || "").trim();
  if (!integrationName) {
    throw new Error("Custom source requires sourceIntegrationName");
  }
  return syncRecipeSource({
    userId: input.userId,
    projectId: input.projectId,
    sourceIntegrationName: integrationName,
    campaignName: input.campaignName,
    attioList: input.attioList,
    stageOpen,
    stageClick,
    stageReply,
    watchAll: false,
    lastSeenAt: null,
    recipe: undefined,
    oneShot: true,
    realEngagement: input.realEngagement,
    onStatus: input.onStatus,
  });
}

/** Resolve campaign status without writing to Attio. */
export async function inspectCampaignForAttioSync(input: {
  userId: string;
  projectId: string;
  sourceProvider: "lemlist" | "brevo" | "other";
  sourceIntegrationName?: string;
  campaignName: string;
}) {
  if (input.sourceProvider === "lemlist") {
    const lemlist = await getIntegration(input.userId, input.projectId, "lemlist");
    const campaign = await resolveLemlistCampaign(lemlist.apiKey, input.campaignName);
    const status = campaign.status || "running";
    return {
      campaign: campaign.name,
      status,
      isCompleted: campaignLooksCompleted(status),
      isRunning: campaignLooksRunning(status),
    };
  }
  if (input.sourceProvider === "brevo") {
    // Brevo list tool already exposes status; treat unknown as completed-friendly one-shot.
    return {
      campaign: input.campaignName,
      status: "unknown",
      isCompleted: false,
      isRunning: true,
      note: "Confirm from brevo_list_campaigns status (sent = completed).",
    };
  }
  const integration = await getCustomIntegration(
    input.userId,
    input.projectId,
    String(input.sourceIntegrationName || ""),
  );
  if (isUnifiedPortal(integration)) {
    const campaign = await resolveUnifiedPortalCampaign(
      integration.apiKey,
      integration.baseUrl,
      input.campaignName,
    );
    const status = campaign.status || "running";
    return {
      campaign: campaign.name,
      status,
      isCompleted: campaignLooksCompleted(status),
      isRunning: campaignLooksRunning(status),
    };
  }
  if (isNexusesOutreach(integration)) {
    const campaign = await resolveOutreachCampaign(
      integration.apiKey,
      integration.baseUrl,
      input.campaignName,
    );
    const status = campaign.status || "running";
    return {
      campaign: campaign.name,
      status,
      isCompleted: campaignLooksCompleted(status) || status === "completed",
      isRunning: !campaignLooksCompleted(status) && status !== "completed",
    };
  }
  return {
    campaign: input.campaignName,
    status: "unknown",
    isCompleted: false,
    isRunning: true,
    note: "Could not read status from this connector — ask the user, or default to one-time sync.",
  };
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
  realEngagement?: boolean;
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
    stageOpen: input.stageOpen || "Open",
    stageClick: input.stageClick || "Click",
    stageReply: input.stageReply || "Open",
    intervalMinutes: Math.min(
      Math.max(input.intervalMinutes || defaultInterval, 1),
      60,
    ),
    recipe: sourceProvider === "other" ? recipe : undefined,
    watchAll,
    realEngagement: Boolean(input.realEngagement),
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
        await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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
          await upsertAttioPerson(attio.apiKey, list.id, list.stageSlug, { ...person, stage: person.stage });
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
    open: job.stageOpen || "Open",
    click: job.stageClick || "Click",
    reply: job.stageReply || "Open",
    sent: "Prospect",
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
      { email: normalized.email, name: normalized.name, stage },
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
