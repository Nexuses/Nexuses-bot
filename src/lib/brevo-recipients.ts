import {
  BREVO_MCP_CAMPAIGNS,
  BREVO_MCP_DEFAULT,
  BREVO_MCP_PROCESSES,
} from "@/lib/integration-constants";
import {
  callBrevoMcpToolRaw,
  listBrevoCampaignsViaMcp,
  listBrevoMcpTools,
  resolveBrevoMcpToolName,
} from "@/lib/brevo-mcp";

const BREVO = "https://api.brevo.com";

function brevoHeaders(apiKey: string) {
  return {
    "api-key": apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function brevoRecipientsType(event: string) {
  const lower = event.trim().toLowerCase();
  if (/click/.test(lower)) return { label: "clicks", recipientsType: "clickers" as const };
  if (/unsub/.test(lower)) return { label: "unsubscribed", recipientsType: "unsubscribed" as const };
  if (/soft.?bounce/.test(lower)) return { label: "soft bounces", recipientsType: "softBounces" as const };
  if (/hard.?bounce|bounce/.test(lower)) {
    return { label: "hard bounces", recipientsType: "hardBounces" as const };
  }
  if (/non.?open/.test(lower)) return { label: "non-openers", recipientsType: "nonOpeners" as const };
  if (/non.?click/.test(lower)) return { label: "non-clickers", recipientsType: "nonClickers" as const };
  if (/^all$|recipient|deliver/.test(lower)) return { label: "all recipients", recipientsType: "all" as const };
  return { label: "opens", recipientsType: "openers" as const };
}

function parseEmailsFromCsv(csv: string) {
  const lines = csv
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [] as Array<{ email: string; name: string }>;

  const split = (line: string) => {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (ch === "," && !inQuotes) {
        cells.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  };

  const header = split(lines[0]).map((h) => h.toLowerCase());
  const emailIdx = header.findIndex((h) => h === "email" || h.includes("email"));
  const firstIdx = header.findIndex((h) => h.includes("first"));
  const lastIdx = header.findIndex((h) => h.includes("last"));
  const nameIdx = header.findIndex((h) => h === "name" || h.includes("fullname"));

  const people = new Map<string, { email: string; name: string }>();
  const start = emailIdx >= 0 ? 1 : 0;
  for (const line of lines.slice(start)) {
    const cells = split(line);
    let email = "";
    if (emailIdx >= 0) email = cells[emailIdx] || "";
    else {
      const found = cells.find((c) => /@/.test(c));
      email = found || "";
    }
    email = email.replace(/^"|"$/g, "").trim().toLowerCase();
    if (!email.includes("@")) continue;
    const name =
      nameIdx >= 0
        ? cells[nameIdx] || ""
        : [firstIdx >= 0 ? cells[firstIdx] : "", lastIdx >= 0 ? cells[lastIdx] : ""]
            .filter(Boolean)
            .join(" ");
    people.set(email, { email, name: name.replace(/^"|"$/g, "").trim() });
  }
  return [...people.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function downloadExportCsv(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`Could not download export file (${res.status})`);
  return text;
}

function extractProcessId(data: unknown): string {
  if (!data) return "";
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (record.processId != null) return String(record.processId);
    if (record.id != null && record.status) return String(record.id);
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text || "")
            : "",
        )
        .join("\n");
      return extractProcessId(text);
    }
  }
  if (typeof data === "string") {
    const match =
      data.match(/"processId"\s*:\s*(\d+)/i) ||
      data.match(/processId["\s:]+(\d+)/i) ||
      data.match(/"id"\s*:\s*(\d+)/);
    return match?.[1] || "";
  }
  return "";
}

function extractExportUrl(data: unknown): string {
  if (!data) return "";
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.export_url === "string") return record.export_url;
    if (typeof record.exportUrl === "string") return record.exportUrl;
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text || "")
            : "",
        )
        .join("\n");
      return extractExportUrl(text);
    }
  }
  if (typeof data === "string") {
    try {
      return extractExportUrl(JSON.parse(data));
    } catch {
      const match = data.match(/https?:\/\/[^\s"']+/);
      return match?.[0] || "";
    }
  }
  return "";
}

function extractStatus(data: unknown): string {
  if (!data) return "";
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.status === "string") return record.status.toLowerCase();
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text || "")
            : "",
        )
        .join("\n");
      return extractStatus(text);
    }
  }
  if (typeof data === "string") {
    const match = data.match(/"status"\s*:\s*"([^"]+)"/i);
    return (match?.[1] || "").toLowerCase();
  }
  return "";
}

async function resolveCampaignId(
  restKey: string | undefined,
  mcpKey: string | undefined,
  campaignQuery: string,
) {
  const q = campaignQuery.trim().toLowerCase();
  if (/^\d+$/.test(campaignQuery.trim())) {
    return { id: campaignQuery.trim(), name: campaignQuery.trim() };
  }

  if (restKey) {
    let offset = 0;
    const limit = 50;
    for (let page = 0; page < 20; page += 1) {
      const data = (await requestJson(
        `${BREVO}/v3/emailCampaigns?limit=${limit}&offset=${offset}&excludeHtmlContent=true`,
        { headers: brevoHeaders(restKey) },
      )) as { campaigns?: Array<Record<string, unknown>>; count?: number };
      const campaigns = data?.campaigns || [];
      const exact = campaigns.find((c) => String(c.name || "").toLowerCase() === q);
      const partial = campaigns.find((c) => String(c.name || "").toLowerCase().includes(q));
      const match = exact || partial;
      if (match?.id != null) {
        return { id: String(match.id), name: String(match.name || campaignQuery) };
      }
      if (campaigns.length < limit) break;
      offset += limit;
    }
  }

  if (mcpKey) {
    const listed = await listBrevoCampaignsViaMcp(mcpKey, { limit: 100 });
    const match =
      listed.campaigns.find((c) => String(c.name || "").toLowerCase() === q) ||
      listed.campaigns.find((c) => String(c.name || "").toLowerCase().includes(q));
    if (match?.id != null && String(match.id)) {
      return { id: String(match.id), name: String(match.name || campaignQuery) };
    }
  }

  throw new Error(
    `Brevo campaign "${campaignQuery}" not found. List campaigns first, then use the exact name.`,
  );
}

async function exportViaRest(
  apiKey: string,
  campaignId: string,
  recipientsType: string,
  onStatus?: (text: string) => void,
) {
  onStatus?.("Starting Brevo recipient export…");
  const created = (await requestJson(
    `${BREVO}/v3/emailCampaigns/${encodeURIComponent(campaignId)}/exportRecipients`,
    {
      method: "POST",
      headers: brevoHeaders(apiKey),
      body: JSON.stringify({ recipientsType }),
    },
  )) as { processId?: number | string };

  const processId = String(created?.processId || "");
  if (!processId) throw new Error("Brevo did not return an export process id");

  for (let i = 0; i < 24; i += 1) {
    onStatus?.(`Waiting for Brevo export… (${i + 1})`);
    const process = (await requestJson(`${BREVO}/v3/processes/${encodeURIComponent(processId)}`, {
      headers: brevoHeaders(apiKey),
    })) as { status?: string; export_url?: string };
    const status = String(process?.status || "").toLowerCase();
    if (status === "completed") {
      const url = process.export_url || "";
      if (!url) throw new Error("Export completed but no download URL was returned");
      onStatus?.("Downloading recipient list…");
      const csv = await downloadExportCsv(url);
      return parseEmailsFromCsv(csv);
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Brevo export ${status}`);
    }
    await sleep(2500);
  }
  throw new Error("Brevo export timed out. Try again in a moment.");
}

async function exportViaMcp(
  apiKey: string,
  campaignId: string,
  recipientsType: string,
  onStatus?: (text: string) => void,
) {
  onStatus?.("Starting Brevo MCP recipient export…");
  const campaignTools = await listBrevoMcpTools(apiKey, BREVO_MCP_CAMPAIGNS);
  const exportTool =
    resolveBrevoMcpToolName(campaignTools, "email_export_recipients").exact ||
    resolveBrevoMcpToolName(campaignTools, "export_recipients").exact ||
    campaignTools.find((t) => /export.*recipient/i.test(t.name))?.name;
  if (!exportTool) {
    throw new Error("No Brevo MCP export-recipients tool available");
  }

  const created = await callBrevoMcpToolRaw(
    apiKey,
    exportTool,
    {
      campaignId: Number(campaignId) || campaignId,
      recipientsType,
    },
    BREVO_MCP_CAMPAIGNS,
  );
  const processId = extractProcessId(created);
  if (!processId) throw new Error("MCP export did not return a process id");

  let processUrl = BREVO_MCP_PROCESSES;
  let processTools: Array<{ name: string; description: string }> = [];
  try {
    processTools = await listBrevoMcpTools(apiKey, BREVO_MCP_PROCESSES);
  } catch {
    processUrl = BREVO_MCP_DEFAULT;
    processTools = await listBrevoMcpTools(apiKey, BREVO_MCP_DEFAULT);
  }

  const getProcess =
    resolveBrevoMcpToolName(processTools, "get_process").exact ||
    resolveBrevoMcpToolName(processTools, "getProcess").exact ||
    processTools.find((t) => /get_process/i.test(t.name))?.name;
  if (!getProcess) throw new Error("No Brevo MCP get_process tool available");

  for (let i = 0; i < 24; i += 1) {
    onStatus?.(`Waiting for Brevo MCP export… (${i + 1})`);
    const process = await callBrevoMcpToolRaw(
      apiKey,
      getProcess,
      { processId: Number(processId) || processId, id: Number(processId) || processId },
      processUrl,
    );
    const status = extractStatus(process);
    if (status === "completed") {
      const url = extractExportUrl(process);
      if (!url) throw new Error("MCP export completed but no download URL was returned");
      onStatus?.("Downloading recipient list…");
      const csv = await downloadExportCsv(url);
      return parseEmailsFromCsv(csv);
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Brevo MCP export ${status}`);
    }
    await sleep(2500);
  }
  throw new Error("Brevo MCP export timed out");
}

/**
 * Resolve who opened/clicked a Brevo campaign.
 * Prefer REST API key (restApiKey). MCP-only keys often cannot do this via api.brevo.com.
 */
export async function brevoPeopleByEvent(input: {
  apiKey: string;
  restApiKey?: string;
  mcpUrl?: string;
  campaign: string;
  event?: string;
  onStatus?: (text: string) => void;
}) {
  const { label, recipientsType } = brevoRecipientsType(input.event || "opens");
  const restKey = (input.restApiKey || (!input.mcpUrl ? input.apiKey : "")).trim() || undefined;
  const mcpKey = input.mcpUrl ? input.apiKey : undefined;

  input.onStatus?.(`Looking up "${input.campaign}" in Brevo…`);
  const campaign = await resolveCampaignId(restKey, mcpKey, input.campaign);
  input.onStatus?.(`Collecting ${label} for ${campaign.name}…`);

  let people: Array<{ email: string; name: string }> = [];
  let mode = "";
  let lastError = "";

  if (restKey) {
    try {
      people = await exportViaRest(restKey, campaign.id, recipientsType, input.onStatus);
      mode = "rest";
    } catch (err) {
      lastError = err instanceof Error ? err.message : "REST export failed";
    }
  }

  if (!people.length && mcpKey) {
    try {
      people = await exportViaMcp(mcpKey, campaign.id, recipientsType, input.onStatus);
      mode = "mcp";
    } catch (err) {
      lastError = err instanceof Error ? err.message : "MCP export failed";
    }
  }

  if (!people.length && !restKey) {
    return {
      ok: false as const,
      needsRestApiKey: true,
      campaign: campaign.name,
      event: label,
      uniquePeople: 0,
      people: [],
      note:
        "Brevo MCP alone cannot reliably return per-person opens/clicks. Paste a standard Brevo API key (not the MCP-only key) in chat and say “also connect this Brevo API key” — we keep MCP and add REST on the same integration. You do not need two separate Brevo apps.",
      error: lastError || "No REST API key on this Brevo connection",
    };
  }

  if (!people.length) {
    throw new Error(
      lastError ||
        `No ${label} found for "${campaign.name}". If this campaign has activity, reconnect with a standard Brevo API key.`,
    );
  }

  return {
    ok: true as const,
    mode,
    campaign: campaign.name,
    campaignId: campaign.id,
    event: label,
    uniquePeople: people.length,
    people: people.slice(0, 25),
    sampleSize: Math.min(25, people.length),
    truncated: people.length > 25,
    note:
      people.length > 25
        ? `Showing a 25-person SAMPLE only (${people.length} total). Do NOT claim you imported everyone from this tool. To put ALL recipients into Attio with stages, call brevo_import_campaigns_to_attio once.`
        : "Per-person list from Brevo recipient export (HTML not included).",
  };
}

/**
 * Full recipient export for server-side imports (no sample cap).
 */
export async function exportBrevoCampaignRecipientsFull(input: {
  apiKey: string;
  restApiKey?: string;
  mcpUrl?: string;
  campaign: string;
  event?: string;
  onStatus?: (text: string) => void;
}) {
  const { label, recipientsType } = brevoRecipientsType(input.event || "all");
  const restKey = (input.restApiKey || (!input.mcpUrl ? input.apiKey : "")).trim() || undefined;
  const mcpKey = input.mcpUrl ? input.apiKey : undefined;

  input.onStatus?.(`Looking up "${input.campaign}" in Brevo…`);
  const campaign = await resolveCampaignId(restKey, mcpKey, input.campaign);
  input.onStatus?.(`Exporting ${label} for ${campaign.name}…`);

  let people: Array<{ email: string; name: string }> = [];
  let lastError = "";

  if (restKey) {
    try {
      people = await exportViaRest(restKey, campaign.id, recipientsType, input.onStatus);
    } catch (err) {
      lastError = err instanceof Error ? err.message : "REST export failed";
    }
  }

  if (!people.length && mcpKey) {
    try {
      people = await exportViaMcp(mcpKey, campaign.id, recipientsType, input.onStatus);
    } catch (err) {
      lastError = err instanceof Error ? err.message : "MCP export failed";
    }
  }

  if (!people.length && !restKey) {
    throw new Error(
      "Brevo MCP alone cannot reliably export full recipient lists. Connect a standard Brevo API key (REST) and retry.",
    );
  }

  if (!people.length) {
    // Empty list is valid (e.g. zero clickers) — only throw when both exports hard-failed
    if (lastError && /timed out|failed|401|403/i.test(lastError)) {
      throw new Error(lastError);
    }
    return { campaignName: campaign.name, campaignId: campaign.id, event: label, people: [] };
  }

  return {
    campaignName: campaign.name,
    campaignId: campaign.id,
    event: label,
    people,
  };
}

/** Validate a classic REST key against api.brevo.com */
export async function validateBrevoRest(apiKey: string) {
  await requestJson(`${BREVO}/v3/account`, { headers: brevoHeaders(apiKey) });
  return { ok: true as const };
}
