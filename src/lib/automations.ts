import { dbConnect } from "@/lib/db";
import { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";
import { callBrevoMcpTool, listBrevoMcpTools } from "@/lib/brevo-mcp";
import { Integration } from "@/models/Integration";
import { Automation } from "@/models/Automation";
import { serializeAutomation, type AutomationDTO } from "@/lib/serialize-automation";

const ATTIO = "https://api.attio.com";
const LEMLIST = "https://api.lemlist.com";

type StoredKey = {
  apiKey: string;
  mcpUrl?: string;
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
    for (const key of ["data", "campaigns", "leads", "activities", "contacts"]) {
      if (Array.isArray(record[key])) return asObjects(record[key]);
    }
  }
  return [];
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

async function resolveLemlistCampaign(apiKey: string, name: string) {
  const campaigns = asObjects(
    await requestJson(`${LEMLIST}/api/campaigns?limit=100&offset=0`, {
      headers: lemlistHeaders(apiKey),
    }),
  );
  const match = campaigns.find(
    (item) => String(item.name || "").toLowerCase() === name.toLowerCase(),
  ) || campaigns.find((item) => String(item.name || "").toLowerCase().includes(name.toLowerCase()));
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

  // Highest intent wins: reply > click > open
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

  // MCP results vary; treat "ended/sent/archived" in text as completed.
  const lower = raw.toLowerCase();
  const completed = /"status"\s*:\s*"(sent|archived|ended|completed|suspended)"/i.test(raw);
  const list = await resolveAttioList(attio.apiKey, job.attioList);

  // Best-effort: extract emails from MCP payload and push to open stage.
  const emails = [...raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) =>
    m[0].toLowerCase(),
  );
  const unique = [...new Set(emails)].slice(0, 150);
  let updated = 0;
  for (const email of unique) {
    try {
      await upsertAttioPerson(
        attio.apiKey,
        list.id,
        list.stageSlug,
        { email },
        job.stageOpen,
      );
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

export async function runAutomationById(automationId: string) {
  await dbConnect();
  const job = await Automation.findById(automationId);
  if (!job || job.status !== "running") return null;

  try {
    const result =
      job.sourceProvider === "lemlist"
        ? await syncLemlistCampaign({
            userId: String(job.userId),
            projectId: String(job.projectId),
            campaignName: job.campaignName,
            attioList: job.attioList,
            stageOpen: job.stageOpen,
            stageClick: job.stageClick,
            stageReply: job.stageReply,
          })
        : await syncBrevoCampaign({
            userId: String(job.userId),
            projectId: String(job.projectId),
            campaignName: job.campaignName,
            attioList: job.attioList,
            stageOpen: job.stageOpen,
            stageClick: job.stageClick,
            stageReply: job.stageReply,
          });

    job.lastRunAt = new Date();
    job.runCount = (job.runCount || 0) + 1;
    job.lastSummary = result.summary;
    job.error = "";
    if (result.completed) {
      job.status = "completed";
      job.lastSummary = `${result.summary} Campaign is complete — automatic updates stopped.`;
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
  }, 30_000);
  // Kick once soon after boot.
  void processDueAutomations().catch(() => undefined);
}

export async function startCampaignAutomation(input: {
  userId: string;
  projectId: string;
  sourceProvider: "lemlist" | "brevo";
  campaignName: string;
  attioList: string;
  stageOpen?: string;
  stageClick?: string;
  stageReply?: string;
  intervalMinutes?: number;
}) {
  await dbConnect();
  ensureAutomationRunner();

  const title = `Auto-update Attio from ${input.sourceProvider} · ${input.campaignName}`;
  const existing = await Automation.findOne({
    userId: input.userId,
    projectId: input.projectId,
    type: "campaign_to_attio",
    sourceProvider: input.sourceProvider,
    campaignName: input.campaignName,
    attioList: input.attioList,
    status: "running",
  });
  if (existing) {
    return serializeAutomation(existing);
  }

  const job = await Automation.create({
    userId: input.userId,
    projectId: input.projectId,
    type: "campaign_to_attio",
    status: "running",
    title,
    sourceProvider: input.sourceProvider,
    campaignName: input.campaignName.trim(),
    attioList: input.attioList.trim(),
    stageOpen: input.stageOpen || "open",
    stageClick: input.stageClick || "click",
    stageReply: input.stageReply || "hot",
    intervalMinutes: Math.min(Math.max(input.intervalMinutes || 2, 1), 60),
    nextRunAt: new Date(),
  });

  // Run first sync immediately.
  const first = await runAutomationById(String(job._id));
  return first || serializeAutomation(job);
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
  const job = await Automation.findOneAndUpdate(
    filter,
    {
      status: "stopped",
      lastSummary: "Stopped by user. Automatic updates are no longer running.",
    },
    { new: true },
  );
  if (!job) throw new Error("No running automation found to stop");
  return serializeAutomation(job);
}

export async function listAutomations(userId: string, projectId: string) {
  await dbConnect();
  ensureAutomationRunner();
  // Also process due jobs when listing (keeps UI fresh without relying only on interval).
  await processDueAutomations(3);
  const docs = await Automation.find({ userId, projectId })
    .sort({ updatedAt: -1 })
    .limit(20)
    .lean();
  return docs.map(serializeAutomation);
}
