import {
  ensureAutomationRunner,
  listAutomations,
  startCampaignAutomation,
  stopAutomation,
} from "@/lib/automations";
import { brevoPeopleByEvent } from "@/lib/brevo-recipients";
import {
  callBrevoMcpTool,
  filterBrevoMcpTools,
  listBrevoCampaignsViaMcp,
  listBrevoMcpTools,
  resolveBrevoMcpToolName,
  summarizeBrevoCampaigns,
  validateBrevoMcp,
} from "@/lib/brevo-mcp";
import { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";
import {
  displayProviderName,
  looksLikeQueryApiKeyAuth,
  looksLikeRawAuthorizationAuth,
  normalizeCustomBaseUrl,
  normalizeMcpUrl,
  normalizeProvider,
  parseAuthType,
  removeIntegrationDoc,
  resolveCustomAuthType,
  upsertIntegrationDoc,
  maskKey,
} from "@/lib/integrations";
import { knownCustomApiGuide } from "@/lib/known-custom-apis";
import { getOauthConnector, isOauthProvider } from "@/lib/oauth/catalog";
import { notionOauthConfigured, notionRequest } from "@/lib/oauth/notion";
import { Integration } from "@/models/Integration";
import { createHtmlShare, beginHtmlDraft, appendHtmlDraft, finishHtmlDraft, createDataDashboardShare } from "@/lib/html-shares";
import { fetchPublicUrl } from "@/lib/fetch-url";
import type { ToolDef } from "@/lib/llm";
import type { AuthType, Provider } from "@/types/chat";

export type StoredIntegration = {
  _id: string;
  provider: Provider;
  name: string;
  apiKey: string;
  restApiKey?: string;
  baseUrl?: string;
  mcpUrl?: string;
  authType?: AuthType;
};

const ATTIO = "https://api.attio.com";
const BREVO = "https://api.brevo.com";
const LEMLIST = "https://api.lemlist.com";

function clip(data: unknown, max = 8000) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…truncated` : text;
}

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  }
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function attioHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function brevoHeaders(apiKey: string) {
  return {
    "api-key": apiKey,
    accept: "application/json",
    "Content-Type": "application/json",
  };
}

function lemlistHeaders(apiKey: string) {
  return {
    Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
}

function otherHeaders(integration: StoredIntegration): Record<string, string> {
  if (looksLikeQueryApiKeyAuth(integration)) {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
  // MailBluster: Authorization: <raw key> (no Bearer prefix)
  if (looksLikeRawAuthorizationAuth(integration)) {
    return {
      Authorization: integration.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
  const auth = integration.authType ?? "bearer";
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

function findByProvider(integrations: StoredIntegration[], provider: Provider) {
  const match = integrations.find((item) => item.provider === provider);
  if (!match) throw new Error(`${provider} is not connected`);
  return match;
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug || "list";
}

function asStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function encodeBody(raw: unknown) {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

function joinUrl(base: string, path: string, allowedHost: string) {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Path is required");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    if (url.hostname !== allowedHost && !url.hostname.endsWith(`.${allowedHost}`)) {
      throw new Error(`URL must stay on ${allowedHost}`);
    }
    return url.toString();
  }
  return `${base}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
}

async function providerRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const init: RequestInit = { method, headers };
  if (body != null && method !== "GET" && method !== "HEAD") {
    init.body = encodeBody(body);
  }
  const data = await requestJson(url, init);
  return clip(data || { ok: true });
}

function asObjectArray(data: unknown) {
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["data", "campaigns", "leads", "activities"]) {
      if (Array.isArray(record[key])) return asObjectArray(record[key]);
    }
  }
  return [] as Record<string, unknown>[];
}

async function fetchLemlistCampaigns(apiKey: string) {
  const campaigns: Record<string, unknown>[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = asObjectArray(
      await requestJson(`${LEMLIST}/api/campaigns?limit=100&offset=${offset}`, {
        headers: lemlistHeaders(apiKey),
      }),
    );
    campaigns.push(...page);
    if (page.length < 100) break;
  }
  return campaigns;
}

async function resolveLemlistCampaign(apiKey: string, nameOrId: string) {
  const query = nameOrId.trim();
  if (!query) throw new Error("Campaign name is required");
  const campaigns = await fetchLemlistCampaigns(apiKey);
  const named = (item: Record<string, unknown>) => String(item.name || "").trim();
  const idMatch = campaigns.find((item) => String(item._id || "") === query);
  const exact = campaigns.filter((item) => named(item).toLowerCase() === query.toLowerCase());
  const partial = campaigns.filter((item) => named(item).toLowerCase().includes(query.toLowerCase()));
  const match = idMatch || (exact.length === 1 ? exact[0] : null) || (partial.length === 1 ? partial[0] : null);
  if (!match) {
    if (partial.length > 1) {
      throw new Error(`Multiple campaigns match "${query}": ${partial.map(named).join(", ")}`);
    }
    const names = campaigns.map(named).filter(Boolean);
    throw new Error(
      `No Lemlist campaign named "${query}". Available campaigns: ${names.slice(0, 25).join(", ") || "none"}`,
    );
  }
  return {
    id: String(match._id || ""),
    name: named(match) || query,
    status: String(match.status || ""),
  };
}

function lemlistEventTypes(raw: string) {
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (/click/.test(lower)) return { label: "clicks", types: ["emailsClicked"] };
  if (/repl/.test(lower)) return { label: "replies", types: ["emailsReplied"] };
  if (/bounce/.test(lower)) return { label: "bounced", types: ["emailsBounced"] };
  if (/unsub/.test(lower)) return { label: "unsubscribed", types: ["emailsUnsubscribed"] };
  if (/interested/.test(lower)) return { label: "interested", types: ["emailsInterested"] };
  if (/^sent$|emails sent|send/.test(lower)) return { label: "sent", types: ["emailsSent"] };
  if (/^emails[A-Z]/.test(value) || /^linkedin[A-Z]/.test(value)) {
    return { label: value, types: [value] };
  }
  return { label: "opens", types: ["emailsOpened"] };
}

async function lemlistListCampaignsSummary(apiKey: string) {
  const campaigns = await fetchLemlistCampaigns(apiKey);
  return clip(
    {
      count: campaigns.length,
      campaigns: campaigns.map((item) => ({
        name: String(item.name || ""),
        status: String(item.status || ""),
      })),
    },
    12000,
  );
}

async function lemlistPeopleByEvent(
  apiKey: string,
  args: Record<string, unknown>,
  onStatus?: (text: string) => void,
) {
  const campaignQuery = String(args.campaign || args.campaignName || args.campaignId || "").trim();
  if (!campaignQuery) throw new Error("Campaign name is required");
  const { label, types } = lemlistEventTypes(String(args.event || args.type || "opens"));
  onStatus?.(`Looking up "${campaignQuery}" in Lemlist…`);
  const campaign = await resolveLemlistCampaign(apiKey, campaignQuery);
  onStatus?.(`Collecting ${label} in ${campaign.name}. This can take a little time…`);

  const people = new Map<string, { email: string; name: string; at: string }>();
  let scanned = 0;
  for (const type of types) {
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = asObjectArray(
        await requestJson(
          `${LEMLIST}/api/activities?campaignId=${encodeURIComponent(campaign.id)}&type=${encodeURIComponent(type)}&version=v2&limit=100&offset=${offset}`,
          { headers: lemlistHeaders(apiKey) },
        ),
      );
      scanned += page.length;
      for (const item of page) {
        const email = String(item.email || item.leadEmail || "").trim().toLowerCase();
        if (!email || !email.includes("@")) continue;
        const name = [item.firstName, item.lastName].filter(Boolean).join(" ").trim() || String(item.fullName || "");
        const at = String(item.createdAt || item.date || "");
        const prev = people.get(email);
        if (!prev || (at && (!prev.at || at < prev.at))) {
          people.set(email, { email, name, at });
        }
      }
      if (page.length && (offset + 100) % 200 === 0) {
        onStatus?.(`Found ${people.size} unique emails so far…`);
      }
      if (page.length < 100) break;
    }
  }

  const rows = [...people.values()].sort((a, b) => a.email.localeCompare(b.email));
  return clip(
    {
      ok: true,
      campaign: campaign.name,
      status: campaign.status,
      event: label,
      uniquePeople: rows.length,
      scanned,
      people: rows.slice(0, 250).map((row) => ({
        email: row.email,
        name: row.name || null,
      })),
      truncated: rows.length > 250,
    },
    14000,
  );
}

function pickAttioId(data: unknown, keys: string[]) {
  const record = data as {
    data?: { id?: Record<string, string>; api_slug?: string };
  };
  const id = record?.data?.id;
  if (id) {
    for (const key of keys) {
      if (id[key]) return id[key];
    }
  }
  return record?.data?.api_slug || "";
}

async function attioCreateListWithStages(
  apiKey: string,
  args: Record<string, unknown>,
) {
  const name = String(args.name || "").trim();
  if (!name) throw new Error("List name is required");

  const parentRaw = String(args.parent_object || args.parentObject || "people")
    .trim()
    .toLowerCase();
  const parentMap: Record<string, string> = {
    person: "people",
    people: "people",
    company: "companies",
    companies: "companies",
    deal: "deals",
    deals: "deals",
  };
  const parentObject = parentMap[parentRaw] || parentRaw || "people";
  const stages = asStringArray(args.stages ?? args.statuses ?? args.stage);
  let apiSlug = slugify(String(args.api_slug || args.apiSlug || name));

  async function createList(slug: string) {
    return requestJson(`${ATTIO}/v2/lists`, {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          name,
          api_slug: slug,
          parent_object: parentObject,
          workspace_access: "full-access",
          workspace_member_access: [],
        },
      }),
    });
  }

  let list: unknown;
  try {
    list = await createList(apiSlug);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (!/slug|unique|already|conflict|400/i.test(message)) throw err;
    apiSlug = `${apiSlug}_${Math.random().toString(36).slice(2, 7)}`;
    list = await createList(apiSlug);
  }

  const listId = pickAttioId(list, ["list_id"]) || apiSlug;
  const createdStages: string[] = [];
  const errors: string[] = [];
  let stageAttribute: string | null = null;

  if (stages.length) {
    const attributeBodies = [
      {
        title: "Stage",
        description: "Pipeline stage",
        api_slug: "stage",
        type: "status",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
      {
        title: "Stage",
        description: "",
        api_slug: "stage",
        type: "status",
        is_required: false,
        is_unique: false,
        is_multiselect: false,
        config: {},
      },
    ];
    for (const data of attributeBodies) {
      try {
        const attribute = await requestJson(
          `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes`,
          {
            method: "POST",
            headers: attioHeaders(apiKey),
            body: JSON.stringify({ data }),
          },
        );
        stageAttribute = pickAttioId(attribute, ["attribute_id"]) || "stage";
        errors.length = 0;
        break;
      } catch (err) {
        errors.push(`Stage attribute: ${err instanceof Error ? err.message : "failed"}`);
        stageAttribute = "stage";
      }
    }

    for (const stage of stages) {
      try {
        await requestJson(
          `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageAttribute || "stage")}/statuses`,
          {
            method: "POST",
            headers: attioHeaders(apiKey),
            body: JSON.stringify({ data: { title: stage } }),
          },
        );
        createdStages.push(stage);
      } catch (err) {
        errors.push(`${stage}: ${err instanceof Error ? err.message : "failed"}`);
      }
    }
  }

  return clip({
    ok: errors.length === 0,
    created: true,
    list_name: name,
    list_id: listId,
    api_slug: apiSlug,
    parent_object: parentObject,
    stages: createdStages,
    errors,
    list,
  });
}

function splitCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if ((char === "," || char === "\t") && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text: string) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) row[header] = (cols[index] || "").trim().replace(/^"|"$/g, "");
    });
    return row;
  });
}

function cell(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const match = Object.keys(row).find((header) => header === key || header.replace(/[_\s]+/g, "") === key.replace(/[_\s]+/g, ""));
    if (match && row[match]) return row[match];
  }
  return "";
}

function parseName(row: Record<string, string>) {
  const full = cell(row, ["name", "full name", "full_name", "contact"]);
  let first = cell(row, ["first name", "first_name", "firstname", "first"]);
  let last = cell(row, ["last name", "last_name", "lastname", "last", "surname"]);
  if (!first && full) {
    const parts = full.split(/\s+/);
    first = parts[0] || "";
    last = parts.slice(1).join(" ");
  }
  return { first, last, full: full || [first, last].filter(Boolean).join(" ") };
}

async function attioImportToList(
  apiKey: string,
  args: Record<string, unknown>,
  files: { name: string; text: string }[] = [],
  onStatus?: (text: string) => void,
) {
  const listName = String(args.list || args.list_name || args.listName || "").trim();
  if (!listName) throw new Error("List name is required");
  const stage = String(args.stage || args.status || "").trim();
  const csvText =
    String(args.csv || args.data || "").trim() ||
    files.find((file) => /\.csv$/i.test(file.name) || file.text.includes(","))?.text ||
    "";
  if (!csvText) throw new Error("No CSV data found. Attach a CSV or pass csv text.");

  const rows = parseCsv(csvText).slice(0, 150);
  if (!rows.length) throw new Error("CSV has no data rows. Include a header row and at least one contact.");

  onStatus?.(`Looking up "${listName}" in Attio…`);
  const lists = (await requestJson(`${ATTIO}/v2/lists`, {
    headers: attioHeaders(apiKey),
  })) as { data?: { name?: string; api_slug?: string; id?: { list_id?: string } }[] };
  const list = (lists.data || []).find(
    (item) =>
      item.name?.toLowerCase() === listName.toLowerCase() ||
      item.api_slug?.toLowerCase() === slugify(listName),
  );
  if (!list) {
    const names = (lists.data || []).map((item) => item.name).filter(Boolean);
    throw new Error(
      `No Attio list named "${listName}". Available lists: ${names.join(", ") || "none"}`,
    );
  }
  const listId = list.id?.list_id || list.api_slug || "";

  const attributes = (await requestJson(
    `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes`,
    { headers: attioHeaders(apiKey) },
  )) as { data?: { api_slug?: string; title?: string; type?: string }[] };
  const statusAttr =
    (attributes.data || []).find((item) => item.type === "status" && /stage|status/i.test(item.api_slug || item.title || "")) ||
    (attributes.data || []).find((item) => item.type === "status");
  const stageSlug = statusAttr?.api_slug || "stage";

  if (stage && statusAttr) {
    try {
      await requestJson(
        `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageSlug)}/statuses`,
        {
          method: "POST",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({ data: { title: stage } }),
        },
      );
    } catch {
      // Stage already exists.
    }
  }

  const added: string[] = [];
  const failed: string[] = [];
  const stageNote = stage ? ` onto "${stage}"` : "";
  onStatus?.(
    `Found the list. Importing ${rows.length} contact${rows.length === 1 ? "" : "s"}${stageNote}. This can take a little time…`,
  );

  for (const [index, row] of rows.entries()) {
    const n = index + 1;
    if (n === 1 || n === rows.length || n % 5 === 0) {
      onStatus?.(`Uploading contact ${n} of ${rows.length} to Attio…`);
    }
    const email = cell(row, ["email", "email address", "e-mail", "work email", "email_address"]);
    const { first, last, full } = parseName(row);
    const label = full || email || "row";
    if (!email || !email.includes("@")) {
      failed.push(`${label}: missing email`);
      continue;
    }
    try {
      const person = await requestJson(
        `${ATTIO}/v2/objects/people/records?matching_attribute=email_addresses`,
        {
          method: "PUT",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({
            data: {
              values: {
                email_addresses: [{ email_address: email }],
                name: [{ first_name: first || full, last_name: last, full_name: full || email }],
              },
            },
          }),
        },
      );
      const recordId = pickAttioId(person, ["record_id"]);
      if (!recordId) throw new Error("Person was not created");
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
        { parent_record_id: recordId, parent_object: "people", entry_values: {} },
      ];
      let listed = false;
      let lastError = "";
      for (const data of payloads) {
        try {
          await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
            method: "PUT",
            headers: attioHeaders(apiKey),
            body: JSON.stringify({ data }),
          });
          listed = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : "failed";
        }
      }
      if (!listed) {
        await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
          method: "POST",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({ data: payloads[0] }),
        });
      }
      added.push(full || email);
    } catch (err) {
      failed.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
    }
  }

  return clip({
    ok: failed.length === 0,
    list: list.name,
    stage: stage || null,
    imported: added.length,
    skipped: failed.length,
    names: added.slice(0, 25),
    errors: failed.slice(0, 15),
  });
}

function httpToolParams(extra: Record<string, unknown> = {}) {
  return {
    type: "object",
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "HTTP method",
      },
      path: {
        type: "string",
        description: "API path like /v2/lists or a full https URL on this provider",
      },
      body: {
        type: "string",
        description: "JSON body as a string for POST/PUT/PATCH. Omit for GET.",
      },
      ...extra,
    },
    required: ["method", "path"],
    additionalProperties: false,
  };
}

export function toolDefinitions(integrations: StoredIntegration[]): ToolDef[] {
  const tools: ToolDef[] = [
    {
      type: "function",
      function: {
          name: "connect_integration",
          description:
            "Connect Attio, Brevo, Lemlist, Notion (internal token), or a custom API using one API key the user pasted in chat. For Notion OAuth (Connect button / authorize page), use start_oauth_connect instead. For Brevo, that single key is the API/MCP key — do not ask for a separate MCP URL. Call this when the user pastes a key for Attio / Brevo / Lemlist / Notion internal token.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["attio", "brevo", "lemlist", "notion", "other"],
              description: "Which product to connect",
            },
            api_key: {
              type: "string",
              description: "The API key or token the user provided",
            },
            name: {
              type: "string",
              description: "Required for provider other: a short name for the custom API",
            },
            base_url: {
              type: "string",
              description: "Optional base URL for a custom API",
            },
            auth_type: {
              type: "string",
              enum: ["bearer", "api-key", "basic", "query"],
              description:
                "Auth style for custom APIs. Default bearer. Use query for SmartLead (?api_key=). SmartLead is auto-detected from the name/base URL.",
            },
          },
          required: ["provider", "api_key"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "start_oauth_connect",
        description:
          "Start a Grok-style OAuth connector flow. Use when the user says integrate / connect / authorize Notion (or another OAuth app) and they did NOT paste an API key. Returns a connect_url — you MUST put exactly this markdown in your reply so the UI shows a Connect button: [Connect Notion](connect_url). Do not only describe steps.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["notion"],
              description: "Which OAuth connector to open",
            },
          },
          required: ["provider"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description:
          "Fetch a public http(s) web page or docs URL and return readable text. Use when the user pastes a link and asks you to read, summarize, follow, or extract from it. Do NOT say you cannot browse the web — call this tool. Only public URLs; private/local addresses are blocked.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Full http:// or https:// URL to fetch",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_integrations",
        description: "List which APIs are already connected for this project. Does not reveal full API keys.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "disconnect_integration",
        description:
          "Disconnect a saved integration by provider name (attio, brevo, lemlist, notion) or custom API name.",
        parameters: {
          type: "object",
          properties: {
            provider: {
              type: "string",
              enum: ["attio", "brevo", "lemlist", "notion", "other"],
              description: "Provider to disconnect",
            },
            name: {
              type: "string",
              description: "Custom API name, or Attio/Brevo/Lemlist/Notion",
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "share_html",
        description:
          "Publish SMALL HTML to a public share link (short pages / tables under ~40 rows). For LARGE HTML use share_html_begin → share_html_append → share_html_finish. For campaign/lead tables prefer share_data_dashboard. Header shows Nexuses logo (left) and client logo (right).",
        parameters: {
          type: "object",
          properties: {
            html: {
              type: "string",
              description: "Full HTML document or snippet to publish (keep small — large payloads truncate)",
            },
            title: {
              type: "string",
              description: "Short title for the share, e.g. Brevo campaign report",
            },
            client_logo: {
              type: "string",
              description:
                "Optional client logo URL for the header right side (e.g. SMI). Defaults to the project logo.",
            },
            client_name: {
              type: "string",
              description: "Optional client/project display name for the header",
            },
          },
          required: ["html"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "share_html_begin",
        description:
          "Start a chunked HTML publish for LARGE dashboards. Returns draft_id. Then call share_html_append many times, then share_html_finish.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Dashboard title" },
            client_logo: { type: "string" },
            client_name: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "share_html_append",
        description:
          "Append the next HTML chunk to a draft (max ~12000 characters per chunk). Call repeatedly until the full document is uploaded. You may call this tool multiple times in one turn.",
        parameters: {
          type: "object",
          properties: {
            draft_id: { type: "string", description: "From share_html_begin" },
            chunk: { type: "string", description: "Next contiguous HTML slice (≤12000 chars)" },
          },
          required: ["draft_id", "chunk"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "share_html_finish",
        description:
          "Finalize a chunked HTML draft and return the public /p/... URL. Call only after all chunks were appended.",
        parameters: {
          type: "object",
          properties: {
            draft_id: { type: "string" },
            title: { type: "string" },
            client_logo: { type: "string" },
            client_name: { type: "string" },
          },
          required: ["draft_id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "share_data_dashboard",
        description:
          "BEST for large campaign/lead reports. Pass structured JSON (title, kpis, columns, rows) — the server builds a branded HTML dashboard with table + optional chart. Supports hundreds of rows without truncating HTML. Prefer this over hand-written HTML tables.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            kpis: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                },
                required: ["label", "value"],
              },
              description: "Up to 8 KPI cards",
            },
            columns: {
              type: "array",
              items: { type: "string" },
              description: "Table header labels",
            },
            rows: {
              type: "array",
              items: {
                type: "array",
                items: { type: "string" },
              },
              description: "Table body: each row is an array of cell strings aligned to columns",
            },
            chart: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["bar", "doughnut"] },
                title: { type: "string" },
                labels: { type: "array", items: { type: "string" } },
                values: { type: "array", items: { type: "number" } },
              },
            },
            client_logo: { type: "string" },
            client_name: { type: "string" },
          },
          required: ["title", "columns", "rows"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "start_campaign_automation",
        description:
          "Start an automatic background sync: keep updating an Attio list from a running Lemlist or Brevo campaign until the campaign is complete. Use when the user says keep updating, continue syncing, auto-update, or until campaign completes. Requires Attio + Lemlist/Brevo connected.",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["lemlist", "brevo"],
              description: "Where the campaign lives",
            },
            campaign: {
              type: "string",
              description: "Campaign name",
            },
            attio_list: {
              type: "string",
              description: "Attio list/pipeline name to update",
            },
            stage_open: { type: "string", description: "Attio stage for opens. Default open." },
            stage_click: { type: "string", description: "Attio stage for clicks. Default click." },
            stage_reply: { type: "string", description: "Attio stage for replies. Default hot." },
            interval_minutes: {
              type: "number",
              description: "How often to sync while running. Default 2.",
            },
          },
          required: ["source", "campaign", "attio_list"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_automations",
        description: "List automatic sync jobs for this project (running, completed, stopped).",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "stop_automation",
        description: "Stop a running automatic campaign→Attio sync.",
        parameters: {
          type: "object",
          properties: {
            campaign: { type: "string", description: "Campaign name to stop syncing" },
            automation_id: { type: "string", description: "Automation id if known" },
          },
          additionalProperties: false,
        },
      },
    },
  ];
  const has = (provider: Provider) => integrations.some((item) => item.provider === provider);

  if (has("attio")) {
    tools.push(
      {
        type: "function",
        function: {
          name: "attio_create_list",
          description:
            "Create an Attio list/pipeline and optionally add kanban stages. Use this whenever the user asks to create a list, board, or pipeline in Attio. Example: name 'Nexuses bot', stages prospect, open, click, hot.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "List name, e.g. Nexuses bot" },
              stages: {
                type: "array",
                items: { type: "string" },
                description: "Pipeline stages in order, e.g. prospect, open, click, hot",
              },
              parent_object: {
                type: "string",
                description: "people, companies, or deals. Default people.",
              },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "attio_import_to_list",
          description:
            "Import people from an attached CSV (or csv text) into an existing Attio list, optionally onto a stage. Use this ONCE when the user uploads a CSV and asks to add/upload contacts to Attio. Do not call attio_api once per row.",
          parameters: {
            type: "object",
            properties: {
              list: { type: "string", description: "Attio list name, e.g. Nexuses bot" },
              stage: { type: "string", description: "Pipeline stage, e.g. prospect" },
              csv: {
                type: "string",
                description: "CSV text including header row. Omit if a CSV file is already attached.",
              },
            },
            required: ["list"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "attio_list_lists",
          description: "List all Attio lists in the workspace.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      {
        type: "function",
        function: {
          name: "attio_list_objects",
          description: "List Attio CRM object types such as people and companies.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      {
        type: "function",
        function: {
          name: "attio_query_records",
          description: "Search Attio records. Use object people or companies. Optional search text.",
          parameters: {
            type: "object",
            properties: {
              object: { type: "string", description: "Object slug, e.g. people or companies" },
              search: { type: "string", description: "Optional name or email search" },
              limit: { type: "number", description: "Max records, default 20" },
            },
            required: ["object"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "attio_api",
          description:
            "Call any Attio REST API v2 endpoint. Use for create/update/delete/search that other Attio tools do not cover. Paths start with /v2/. Attio write bodies are usually {\"data\":{...}}.",
          parameters: httpToolParams(),
        },
      },
    );
  }

  if (has("brevo")) {
    const brevo = integrations.find((item) => item.provider === "brevo");
    // Always expose campaign listing — works for MCP and REST keys.
    tools.push(
      {
        type: "function",
        function: {
          name: "brevo_list_campaigns",
          description:
            "List Brevo email campaigns as a compact summary (name, subject, status, dates, stats — NO HTML). Use for any campaign list / partial list. Only set status when the user asks for a specific status (sent/completed, draft, etc.). Default is ALL campaigns.",
          parameters: {
            type: "object",
            properties: {
              status: {
                type: "string",
                description:
                  "Optional filter only when user asks: sent, draft, queued, suspended, archive, in_process. Leave empty for a partial/full list of all campaigns.",
              },
              limit: { type: "number", description: "Max campaigns, default 50" },
              offset: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "brevo_people_by_event",
          description:
            "List individual emails who opened or clicked a Brevo campaign (or other recipient types). Use when the user asks who opened / clicked / drill-down people for a campaign. Prefer this over guessing MCP tools.",
          parameters: {
            type: "object",
            properties: {
              campaign: { type: "string", description: "Campaign name or id" },
              event: {
                type: "string",
                description: "opens, clicks, unsubscribed, softBounces, hardBounces, all",
              },
            },
            required: ["campaign"],
            additionalProperties: false,
          },
        },
      },
    );

    if (brevo?.mcpUrl) {
      tools.push(
        {
          type: "function",
          function: {
            name: "brevo_mcp_list_tools",
            description:
              "Search Brevo MCP tools by keyword. ALWAYS pass query (e.g. campaign, contact, list). Do not request the full unfiltered catalog — it is huge and gets truncated.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description: "Filter text, e.g. campaign, contact, analytics",
                },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "brevo_mcp_call",
            description:
              "Call a Brevo MCP tool by name with JSON arguments. For listing campaigns use brevo_list_campaigns instead. Pass exact tool name from brevo_mcp_list_tools.",
            parameters: {
              type: "object",
              properties: {
                tool: {
                  type: "string",
                  description: "Exact MCP tool name from brevo_mcp_list_tools",
                },
                arguments: {
                  type: "object",
                  description: "Arguments object for that MCP tool",
                },
              },
              required: ["tool"],
              additionalProperties: false,
            },
          },
        },
      );
    } else {
      tools.push(
        {
          type: "function",
          function: {
            name: "brevo_list_contacts",
            description: "List Brevo contacts.",
            parameters: {
              type: "object",
              properties: {
                limit: { type: "number" },
                offset: { type: "number" },
              },
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "brevo_create_contact",
            description: "Create or update a Brevo contact by email. Use this when the user asks to add a contact.",
            parameters: {
              type: "object",
              properties: {
                email: { type: "string" },
                firstName: { type: "string" },
                lastName: { type: "string" },
              },
              required: ["email"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "brevo_api",
            description:
              "Call any Brevo API v3 endpoint. Use this to create lists, campaigns, send emails, or any other Brevo action. Paths start with /v3/.",
            parameters: httpToolParams(),
          },
        },
      );
    }
  }

  if (has("lemlist")) {
    tools.push(
      {
        type: "function",
        function: {
          name: "lemlist_list_campaigns",
          description:
            "List Lemlist campaigns with name and status only. Completed campaigns have status ended. Use this when the user asks for campaigns, completed campaigns, running campaigns, or a status breakdown.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      {
        type: "function",
        function: {
          name: "lemlist_people_by_event",
          description:
            "List unique people (email and name) in a Lemlist campaign for an event. Use this ONCE when the user asks who opened, clicked, replied, bounced, or was sent mail. Pass the campaign name. Do not paginate with lemlist_api.",
          parameters: {
            type: "object",
            properties: {
              campaign: {
                type: "string",
                description: "Campaign name, e.g. Test Campaign",
              },
              event: {
                type: "string",
                description: "opens, clicks, replies, bounced, sent, or unsubscribed. Default opens.",
              },
            },
            required: ["campaign"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "lemlist_list_leads",
          description: "List leads in a Lemlist campaign. Pass the campaign name.",
          parameters: {
            type: "object",
            properties: {
              campaign: { type: "string", description: "Campaign name" },
              campaignId: { type: "string", description: "Only if you already have the campaign id" },
              limit: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "lemlist_list_activities",
          description: "List recent Lemlist campaign activity. Prefer lemlist_people_by_event for who opened/clicked/replied.",
          parameters: {
            type: "object",
            properties: {
              campaign: { type: "string", description: "Campaign name" },
              campaignId: { type: "string" },
              type: { type: "string", description: "emailsOpened, emailsClicked, emailsReplied, etc." },
              limit: { type: "number" },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "lemlist_api",
          description:
            "Call any Lemlist API endpoint. Use only when the other Lemlist tools cannot do the job. Paths start with /api/.",
          parameters: httpToolParams(),
        },
      },
    );
  }

  if (has("notion")) {
    tools.push(
      {
        type: "function",
        function: {
          name: "notion_search",
          description:
            "Search Notion pages and databases the user shared with this connection. Use for find / search / list Notion content.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search text. Empty lists recent shared pages." },
              limit: { type: "number", description: "Max results, default 20" },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "notion_create_page",
          description:
            "Create a Notion page under a parent page. Pass parent page id (from notion_search) and title. Optional plain-text body.",
          parameters: {
            type: "object",
            properties: {
              parent_page_id: {
                type: "string",
                description: "Parent page id from notion_search",
              },
              title: { type: "string", description: "Page title" },
              content: {
                type: "string",
                description: "Optional plain text to put as the first paragraph",
              },
            },
            required: ["parent_page_id", "title"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "notion_api",
          description:
            "Call any Notion REST API path (e.g. /v1/users/me, /v1/blocks/{id}/children). Use when notion_search / notion_create_page are not enough.",
          parameters: httpToolParams(),
        },
      },
    );
  }

  const custom = integrations.filter((item) => item.provider === "other");
  if (custom.length) {
    tools.push({
      type: "function",
      function: {
        name: "custom_api_request",
        description: `Call a connected custom API and complete the user's task. Available: ${custom
          .map((item) => {
            const mode = looksLikeQueryApiKeyAuth(item)
              ? "auth=query api_key"
              : looksLikeRawAuthorizationAuth(item)
                ? "auth=Authorization raw key"
                : `auth=${item.authType || "bearer"}`;
            return `${item.name} (${mode}${item.baseUrl ? `, base ${item.baseUrl}` : ""})`;
          })
          .join("; ")}. For SmartLead use paths under /campaigns etc. — the server attaches ?api_key= automatically. For MailBluster use https://api.mailbluster.com paths like /api/leads — campaigns/opens/clicks are NOT available via their Developer API.`,
        parameters: {
          type: "object",
          properties: {
            integration: {
              type: "string",
              description: "Name of the connected custom API",
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            },
            path: {
              type: "string",
              description: "Path like /campaigns or /v1/items or a full https URL (without api_key)",
            },
            body: {
              type: "string",
              description: "Optional JSON body as a string",
            },
          },
          required: ["integration", "method", "path"],
          additionalProperties: false,
        },
      },
    });
  }

  return tools;
}

export type ToolContext = {
  files?: { name: string; text: string }[];
  onStatus?: (text: string) => void;
  userId?: string;
  projectId?: string;
  projectName?: string;
  projectLogo?: string;
  origin?: string;
  secretsUsed?: string[];
  onIntegrationsChange?: (integrations: StoredIntegration[]) => void;
};

export async function runTool(
  name: string,
  rawArgs: string | Record<string, unknown> | null | undefined,
  integrations: StoredIntegration[],
  context: ToolContext = {},
) {
  let args: Record<string, unknown> = {};
  try {
    if (rawArgs && typeof rawArgs === "object") args = rawArgs;
    else if (rawArgs) args = JSON.parse(rawArgs);
  } catch {
    const hint =
      name === "share_html" || name.startsWith("share_html_") || name === "share_data_dashboard"
        ? " HTML/tool JSON was truncated. For large pages use share_data_dashboard (rows as JSON) or share_html_begin → share_html_append (≤12000 chars) → share_html_finish."
        : "";
    throw new Error(`Invalid tool arguments.${hint}`);
  }

  const method = String(args.method || "GET").toUpperCase();

  if (name === "list_integrations") {
    return clip({
      connected: integrations.map((item) => ({
        name: item.name,
        provider: item.provider,
        keyHint: maskKey(item.apiKey),
        baseUrl: item.baseUrl || null,
        mcpUrl: item.mcpUrl || null,
      })),
      count: integrations.length,
    });
  }

  if (name === "start_oauth_connect") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot start OAuth in this context");
    }
    const provider = String(args.provider || "").trim().toLowerCase();
    if (!isOauthProvider(provider)) {
      throw new Error('Supported OAuth connectors right now: "notion"');
    }
    const connector = getOauthConnector(provider);
    if (provider === "notion" && !notionOauthConfigured()) {
      throw new Error(
        "Notion OAuth is not configured on the server. Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET, and set the redirect URI to {APP_URL}/api/oauth/notion/callback in the Notion public integration.",
      );
    }
    const connectUrl = `/api/oauth/${provider}/start?projectId=${encodeURIComponent(context.projectId)}`;
    const label = connector?.title || "Connect";
    const markdown = `[Connect ${label}](${connectUrl})`;
    context.onStatus?.(`Preparing ${label} authorization…`);
    return clip({
      ok: true,
      provider,
      connect_url: connectUrl,
      button_markdown: markdown,
      note: `Put this exact markdown in your reply so the user gets a Connect button: ${markdown}. After they authorize and return, Notion tools become available — then continue their request.`,
    });
  }

  if (name === "fetch_url") {
    const url = String(args.url || args.link || "").trim();
    if (!url) throw new Error("url is required");
    context.onStatus?.("Reading the page…");
    const result = await fetchPublicUrl(url);
    return clip(result, 42000);
  }

  if (name === "share_html") {
    if (!context.userId) throw new Error("Cannot create a share link in this context");
    const html = String(args.html || args.content || "").trim();
    const title = String(args.title || "").trim();
    const clientLogo = String(args.client_logo || args.clientLogo || context.projectLogo || "").trim();
    const clientName = String(args.client_name || args.clientName || context.projectName || "").trim();
    const origin = context.origin;
    if (html.length > 80_000) {
      throw new Error(
        `HTML is too large for a single share_html call (${html.length} chars). Use share_data_dashboard for tables, or share_html_begin → share_html_append → share_html_finish.`,
      );
    }
    context.onStatus?.("Creating a public link…");
    const share = await createHtmlShare({
      userId: context.userId,
      projectId: context.projectId,
      html,
      title: title || undefined,
      origin,
      clientLogoUrl: clientLogo || undefined,
      clientName: clientName || undefined,
    });
    return clip({
      ok: true,
      title: share.title,
      url: share.url,
      note: "Share this public URL. Header shows Nexuses logo (left) and client/project logo (right).",
    });
  }

  if (name === "share_html_begin") {
    if (!context.userId) throw new Error("Cannot create a share link in this context");
    context.onStatus?.("Starting chunked HTML publish…");
    const draft = await beginHtmlDraft({
      userId: context.userId,
      projectId: context.projectId,
      title: String(args.title || "").trim() || undefined,
      clientLogoUrl: String(args.client_logo || args.clientLogo || context.projectLogo || "").trim() || undefined,
      clientName: String(args.client_name || args.clientName || context.projectName || "").trim() || undefined,
    });
    return clip({ ok: true, ...draft });
  }

  if (name === "share_html_append") {
    if (!context.userId) throw new Error("Cannot create a share link in this context");
    const draftId = String(args.draft_id || args.draftId || "").trim();
    const chunk = String(args.chunk || args.html || "");
    context.onStatus?.("Uploading HTML chunk…");
    const progress = await appendHtmlDraft({
      userId: context.userId,
      draftId,
      chunk,
    });
    return clip({ ok: true, ...progress });
  }

  if (name === "share_html_finish") {
    if (!context.userId) throw new Error("Cannot create a share link in this context");
    const draftId = String(args.draft_id || args.draftId || "").trim();
    context.onStatus?.("Publishing the dashboard…");
    const share = await finishHtmlDraft({
      userId: context.userId,
      draftId,
      origin: context.origin,
      title: String(args.title || "").trim() || undefined,
      clientLogoUrl: String(args.client_logo || args.clientLogo || "").trim() || undefined,
      clientName: String(args.client_name || args.clientName || "").trim() || undefined,
    });
    return clip({
      ok: true,
      title: share.title,
      url: share.url,
      note: "Chunked publish complete. Paste this exact URL in your reply.",
    });
  }

  if (name === "share_data_dashboard") {
    if (!context.userId) throw new Error("Cannot create a share link in this context");
    const title = String(args.title || "").trim();
    if (!title) throw new Error("title is required");
    const columns = asStringArray(args.columns);
    if (!columns.length) throw new Error("columns are required");
    const rawRows = Array.isArray(args.rows) ? args.rows : [];
    const rows = rawRows.map((row) =>
      Array.isArray(row) ? row.map((cell) => (cell == null ? "" : String(cell))) : [String(row ?? "")],
    );
    const kpis = Array.isArray(args.kpis)
      ? args.kpis.map((item) => {
          const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          return {
            label: String(row.label || "").trim(),
            value: String(row.value ?? "").trim(),
          };
        })
      : [];
    let chart: {
      type?: "bar" | "doughnut";
      title?: string;
      labels: string[];
      values: number[];
    } | undefined;
    if (args.chart && typeof args.chart === "object") {
      const c = args.chart as Record<string, unknown>;
      chart = {
        type: c.type === "doughnut" ? "doughnut" : "bar",
        title: String(c.title || "").trim() || undefined,
        labels: asStringArray(c.labels),
        values: (Array.isArray(c.values) ? c.values : []).map((n) => Number(n) || 0),
      };
    }
    context.onStatus?.("Building the dashboard…");
    const share = await createDataDashboardShare({
      userId: context.userId,
      projectId: context.projectId,
      origin: context.origin,
      clientLogoUrl: String(args.client_logo || args.clientLogo || context.projectLogo || "").trim() || undefined,
      clientName: String(args.client_name || args.clientName || context.projectName || "").trim() || undefined,
      dashboard: {
        title,
        subtitle: String(args.subtitle || "").trim() || undefined,
        kpis,
        columns,
        rows,
        chart,
      },
    });
    return clip({
      ok: true,
      title: share.title,
      url: share.url,
      rows: rows.length,
      note: "Server-built dashboard. Paste this exact URL in your reply.",
    });
  }

  if (name === "start_campaign_automation") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot start automation in this context");
    }
    ensureAutomationRunner();
    const source = String(args.source || args.provider || "lemlist").toLowerCase();
    if (source !== "lemlist" && source !== "brevo") {
      throw new Error('source must be "lemlist" or "brevo"');
    }
    const campaign = String(args.campaign || args.campaignName || "").trim();
    const attioList = String(args.attio_list || args.attioList || args.list || "").trim();
    if (!campaign) throw new Error("Campaign name is required");
    if (!attioList) throw new Error("Attio list name is required");
    context.onStatus?.(`Starting automatic updates for ${campaign}…`);
    const automation = await startCampaignAutomation({
      userId: context.userId,
      projectId: context.projectId,
      sourceProvider: source,
      campaignName: campaign,
      attioList,
      stageOpen: String(args.stage_open || args.stageOpen || "open"),
      stageClick: String(args.stage_click || args.stageClick || "click"),
      stageReply: String(args.stage_reply || args.stageReply || "hot"),
      intervalMinutes: Number(args.interval_minutes || args.intervalMinutes) || 2,
    });
    return clip({
      ok: true,
      automation,
      note: `Automatic update is running. Attio list "${automation.attioList}" will keep syncing from ${automation.sourceProvider} campaign "${automation.campaignName}" until the campaign completes (or you stop it).`,
    });
  }

  if (name === "list_automations") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot list automations in this context");
    }
    ensureAutomationRunner();
    const automations = await listAutomations(context.userId, context.projectId);
    return clip({ count: automations.length, automations });
  }

  if (name === "stop_automation") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot stop automation in this context");
    }
    const stopped = await stopAutomation({
      userId: context.userId,
      projectId: context.projectId,
      automationId: String(args.automation_id || args.automationId || "").trim() || undefined,
      campaignName: String(args.campaign || args.campaignName || "").trim() || undefined,
    });
    return clip({ ok: true, automation: stopped });
  }

  if (name === "connect_integration") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot save integrations in this context");
    }
    const provider = normalizeProvider(String(args.provider || ""));
    const apiKey = String(args.api_key || args.apiKey || "").trim();
    if (!apiKey) throw new Error("API key is required");
    let authType = parseAuthType(args.auth_type || args.authType);
    const label = displayProviderName(provider, String(args.name || ""));
    let baseUrl =
      provider === "other"
        ? normalizeCustomBaseUrl(label, String(args.base_url || args.baseUrl || ""))
        : String(args.base_url || args.baseUrl || "").trim();
    if (provider === "other") {
      authType = resolveCustomAuthType({ name: label, baseUrl, authType });
      if (looksLikeQueryApiKeyAuth({ name: label, baseUrl, authType }) && !baseUrl) {
        baseUrl = "https://server.smartlead.ai/api/v1";
      }
      if (looksLikeRawAuthorizationAuth({ name: label, baseUrl, authType }) && !baseUrl) {
        baseUrl = "https://api.mailbluster.com";
      }
    }
    context.onStatus?.(`Connecting ${label} and checking the API key…`);
    const validated = await validateIntegration({ provider, apiKey, baseUrl, authType });

    let saved;
    if (provider === "brevo") {
      const existing = await Integration.findOne({
        userId: context.userId,
        projectId: context.projectId,
        provider: "brevo",
      });
      const isRestKey = !validated.mcpUrl;
      if (existing?.mcpUrl && isRestKey) {
        // Keep MCP token; add classic REST key for recipient exports.
        saved = await upsertIntegrationDoc({
          userId: context.userId,
          projectId: context.projectId,
          provider,
          name: label,
          apiKey,
          restOnly: true,
        });
      } else if (existing && !existing.mcpUrl && validated.mcpUrl) {
        // Upgrading REST connection to MCP — keep previous key as restApiKey.
        saved = await upsertIntegrationDoc({
          userId: context.userId,
          projectId: context.projectId,
          provider,
          name: label,
          apiKey,
          restApiKey: existing.apiKey,
          mcpUrl: validated.mcpUrl,
          authType,
        });
      } else {
        saved = await upsertIntegrationDoc({
          userId: context.userId,
          projectId: context.projectId,
          provider,
          name: label,
          apiKey,
          restApiKey: existing?.restApiKey || "",
          mcpUrl: validated.mcpUrl ?? "",
          authType,
        });
      }
    } else {
      const mcpUrl = normalizeMcpUrl(String(args.mcp_url || args.mcpUrl || ""));
      saved = await upsertIntegrationDoc({
        userId: context.userId,
        projectId: context.projectId,
        provider,
        name: label,
        apiKey,
        baseUrl,
        mcpUrl,
        authType,
      });
    }

    context.secretsUsed?.push(apiKey);
    const stored: StoredIntegration = {
      _id: saved._id,
      provider: saved.provider,
      name: saved.name,
      apiKey: saved.apiKey,
      restApiKey: saved.restApiKey || "",
      baseUrl: saved.baseUrl,
      mcpUrl: saved.mcpUrl,
      authType: saved.authType,
    };
    const next =
      provider === "other"
        ? [...integrations.filter((item) => !(item.provider === "other" && item.name === stored.name)), stored]
        : [...integrations.filter((item) => item.provider !== provider), stored];
    integrations.splice(0, integrations.length, ...next);
    context.onIntegrationsChange?.(integrations);
    const mode =
      provider === "brevo"
        ? saved.mcpUrl && saved.hasRestApiKey
          ? "mcp+rest"
          : saved.mcpUrl
            ? "mcp"
            : "api"
        : null;
    return clip({
      ok: true,
      connected: saved.name,
      provider: saved.provider,
      keyHint: saved.keyHint,
      mode,
      mcpUrl: saved.mcpUrl || null,
      hasRestApiKey: Boolean(saved.hasRestApiKey),
      note:
        mode === "mcp+rest"
          ? "Brevo MCP + REST API key are both saved on one connection. Campaign lists use MCP; who opened/clicked uses REST export."
          : mode === "mcp"
            ? "Brevo is connected via MCP. For who opened/clicked a campaign, also paste a standard Brevo API key (not MCP-only) and say connect Brevo — we will add it alongside MCP."
            : `${saved.name} is connected. You can use its tools now in this chat.`,
    });
  }

  if (name === "disconnect_integration") {
    if (!context.userId || !context.projectId) {
      throw new Error("Cannot change integrations in this context");
    }
    const rawProvider = String(args.provider || "").trim();
    const rawName = String(args.name || "").trim();
    let provider: Provider | undefined;
    let name = rawName;
    if (rawProvider) {
      provider = normalizeProvider(rawProvider);
    } else if (rawName) {
      const lower = rawName.toLowerCase();
      if (lower === "attio" || lower === "brevo" || lower === "lemlist") {
        provider = lower as Provider;
        name = "";
      }
    }
    context.onStatus?.(`Disconnecting ${name || provider || "integration"}…`);
    const removed = await removeIntegrationDoc({
      userId: context.userId,
      projectId: context.projectId,
      provider,
      name: name || undefined,
    });
    const next = integrations.filter((item) => item._id !== removed._id);
    integrations.splice(0, integrations.length, ...next);
    context.onIntegrationsChange?.(integrations);
    return clip({
      ok: true,
      disconnected: removed.name,
      provider: removed.provider,
    });
  }

  if (name === "attio_create_list") {
    const attio = findByProvider(integrations, "attio");
    return attioCreateListWithStages(attio.apiKey, args);
  }

  if (name === "attio_import_to_list") {
    const attio = findByProvider(integrations, "attio");
    return attioImportToList(attio.apiKey, args, context.files, context.onStatus);
  }

  if (name === "attio_list_lists") {
    const attio = findByProvider(integrations, "attio");
    const data = await requestJson(`${ATTIO}/v2/lists`, {
      headers: attioHeaders(attio.apiKey),
    });
    return clip(data);
  }

  if (name === "attio_list_objects") {
    const attio = findByProvider(integrations, "attio");
    const data = await requestJson(`${ATTIO}/v2/objects`, {
      headers: attioHeaders(attio.apiKey),
    });
    return clip(data);
  }

  if (name === "attio_query_records") {
    const attio = findByProvider(integrations, "attio");
    const object = String(args.object || "people");
    const limit = Math.min(Number(args.limit) || 20, 50);
    const search = String(args.search || "").trim();
    const body: Record<string, unknown> = { limit };
    if (search) {
      body.filter = {
        $or: [
          { name: { $contains: search } },
          { email_addresses: { email_address: { $contains: search } } },
        ],
      };
    }
    try {
      const data = await requestJson(
        `${ATTIO}/v2/objects/${encodeURIComponent(object)}/records/query`,
        {
          method: "POST",
          headers: attioHeaders(attio.apiKey),
          body: JSON.stringify(body),
        },
      );
      return clip(data);
    } catch {
      const data = await requestJson(
        `${ATTIO}/v2/objects/${encodeURIComponent(object)}/records/query`,
        {
          method: "POST",
          headers: attioHeaders(attio.apiKey),
          body: JSON.stringify({ limit }),
        },
      );
      return clip(data);
    }
  }

  if (name === "attio_api") {
    const attio = findByProvider(integrations, "attio");
    const url = joinUrl(ATTIO, String(args.path || ""), "api.attio.com");
    return providerRequest(url, method, attioHeaders(attio.apiKey), args.body);
  }

  if (name === "brevo_mcp_list_tools") {
    const brevo = findByProvider(integrations, "brevo");
    const query = String(args.query || args.q || args.search || "").trim();
    if (!query) {
      return clip({
        ok: false,
        note: 'Pass query, e.g. query="campaign". The full Brevo tool catalog is too large to return unfiltered.',
      });
    }
    const all = await listBrevoMcpTools(brevo.apiKey, brevo.mcpUrl || BREVO_MCP_DEFAULT);
    const tools = filterBrevoMcpTools(all, query);
    return clip({
      mode: "mcp",
      query,
      totalAvailable: all.length,
      matched: tools.length,
      tools: tools.slice(0, 60).map((tool) => ({
        name: tool.name,
        description: (tool.description || "").slice(0, 160),
      })),
      note:
        tools.length > 60
          ? "Showing first 60 matches. Narrow the query if needed."
          : "Use exact tool names with brevo_mcp_call. For campaigns prefer brevo_list_campaigns.",
    });
  }

  if (name === "brevo_mcp_call") {
    const brevo = findByProvider(integrations, "brevo");
    const toolName = String(args.tool || args.name || "").trim();
    if (!toolName) throw new Error("MCP tool name is required");
    const toolArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};

    const all = await listBrevoMcpTools(brevo.apiKey, brevo.mcpUrl || BREVO_MCP_DEFAULT);
    const resolved = resolveBrevoMcpToolName(all, toolName);
    const finalName = resolved.exact || toolName;
    if (!resolved.exact) {
      const suggestions =
        resolved.suggestions.length > 0
          ? resolved.suggestions
          : filterBrevoMcpTools(all, toolName.split(/[_\s]+/)[0] || toolName)
              .map((t) => t.name)
              .slice(0, 12);
      if (!suggestions.includes(finalName)) {
        return clip({
          ok: false,
          error: `Unknown tool "${toolName}"`,
          suggestions,
          note: "Use one of the suggestions with brevo_mcp_call, or use brevo_list_campaigns for campaign lists.",
        });
      }
    }

    try {
      return await callBrevoMcpTool(
        brevo.apiKey,
        finalName,
        toolArgs,
        brevo.mcpUrl || BREVO_MCP_DEFAULT,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP call failed";
      if (/unknown tool|not found|invalid tool/i.test(message)) {
        const suggestions = resolveBrevoMcpToolName(all, toolName).suggestions;
        return clip({
          ok: false,
          error: message,
          suggestions,
          note: "For campaigns use brevo_list_campaigns instead of guessing MCP names.",
        });
      }
      throw err;
    }
  }

  if (name === "brevo_list_contacts") {
    const brevo = findByProvider(integrations, "brevo");
    const limit = Math.min(Number(args.limit) || 20, 50);
    const offset = Number(args.offset) || 0;
    const data = await requestJson(
      `${BREVO}/v3/contacts?limit=${limit}&offset=${offset}`,
      { headers: brevoHeaders(brevo.apiKey) },
    );
    return clip(data);
  }

  if (name === "brevo_create_contact") {
    const brevo = findByProvider(integrations, "brevo");
    const data = await requestJson(`${BREVO}/v3/contacts`, {
      method: "POST",
      headers: brevoHeaders(brevo.apiKey),
      body: JSON.stringify({
        email: args.email,
        attributes: {
          FIRSTNAME: args.firstName || undefined,
          LASTNAME: args.lastName || undefined,
        },
        updateEnabled: true,
      }),
    });
    return clip(data || { ok: true });
  }

  if (name === "brevo_list_campaigns") {
    const brevo = findByProvider(integrations, "brevo");
    const limit = Math.min(Number(args.limit) || 50, 100);
    const offset = Number(args.offset) || 0;
    // Only filter when the model explicitly passes a real status — not "partial"/"all".
    const rawStatus = String(args.status || "").trim().toLowerCase();
    const status = [
      "sent",
      "draft",
      "queued",
      "suspended",
      "archive",
      "in_process",
      "inProcess",
    ].includes(rawStatus)
      ? rawStatus === "inprocess"
        ? "in_process"
        : rawStatus
      : "";
    context.onStatus?.(
      status ? `Loading Brevo campaigns (${status})…` : "Loading Brevo campaigns…",
    );

    const restKey = (brevo.restApiKey || (!brevo.mcpUrl ? brevo.apiKey : "")).trim();
    if (restKey) {
      try {
        const qs = new URLSearchParams({
          limit: String(limit),
          offset: String(offset),
          excludeHtmlContent: "true",
        });
        if (status) qs.set("status", status);
        const data = await requestJson(`${BREVO}/v3/emailCampaigns?${qs}`, {
          headers: brevoHeaders(restKey),
        });
        return clip({ mode: "rest", ...summarizeBrevoCampaigns(data, { limit }) });
      } catch {
        // fall through to MCP when REST fails
      }
    }

    if (brevo.mcpUrl) {
      const viaMcp = await listBrevoCampaignsViaMcp(brevo.apiKey, {
        status: status || undefined,
        limit,
        offset,
      });
      return clip(viaMcp);
    }

    throw new Error("Brevo is not connected");
  }

  if (name === "brevo_people_by_event") {
    const brevo = findByProvider(integrations, "brevo");
    const campaign = String(args.campaign || args.campaignName || "").trim();
    if (!campaign) throw new Error("Campaign name is required");
    const result = await brevoPeopleByEvent({
      apiKey: brevo.apiKey,
      restApiKey: brevo.restApiKey,
      mcpUrl: brevo.mcpUrl,
      campaign,
      event: String(args.event || args.type || "opens"),
      onStatus: context.onStatus,
    });
    return clip(result);
  }

  if (name === "brevo_api") {
    const brevo = findByProvider(integrations, "brevo");
    const url = joinUrl(BREVO, String(args.path || ""), "api.brevo.com");
    return providerRequest(url, method, brevoHeaders(brevo.apiKey), args.body);
  }

  if (name === "lemlist_list_campaigns") {
    const lemlist = findByProvider(integrations, "lemlist");
    return lemlistListCampaignsSummary(lemlist.apiKey);
  }

  if (name === "lemlist_people_by_event") {
    const lemlist = findByProvider(integrations, "lemlist");
    return lemlistPeopleByEvent(lemlist.apiKey, args, context.onStatus);
  }

  if (name === "lemlist_list_leads") {
    const lemlist = findByProvider(integrations, "lemlist");
    const campaignQuery = String(args.campaign || args.campaignId || "").trim();
    if (!campaignQuery) throw new Error("Campaign name is required");
    const campaign = await resolveLemlistCampaign(lemlist.apiKey, campaignQuery);
    const limit = Math.min(Number(args.limit) || 50, 100);
    const data = await requestJson(
      `${LEMLIST}/api/campaigns/${encodeURIComponent(campaign.id)}/leads/?limit=${limit}&offset=0`,
      { headers: lemlistHeaders(lemlist.apiKey) },
    );
    const leads = asObjectArray(data).map((item) => {
      const variables =
        item.variables && typeof item.variables === "object"
          ? (item.variables as Record<string, unknown>)
          : {};
      return {
        email: item.email || variables.email,
        firstName: item.firstName,
        lastName: item.lastName,
        status: item.status || item.state,
      };
    });
    return clip({ campaign: campaign.name, count: leads.length, leads });
  }

  if (name === "lemlist_list_activities") {
    const lemlist = findByProvider(integrations, "lemlist");
    const campaignQuery = String(args.campaign || args.campaignId || "").trim();
    if (!campaignQuery) throw new Error("Campaign name is required");
    const campaign = await resolveLemlistCampaign(lemlist.apiKey, campaignQuery);
    const limit = Math.min(Number(args.limit) || 50, 100);
    const type = String(args.type || "").trim();
    const params = new URLSearchParams({
      campaignId: campaign.id,
      version: "v2",
      limit: String(limit),
      offset: "0",
    });
    if (type) params.set("type", type);
    const data = await requestJson(`${LEMLIST}/api/activities?${params}`, {
      headers: lemlistHeaders(lemlist.apiKey),
    });
    return clip({ campaign: campaign.name, activities: asObjectArray(data) });
  }

  if (name === "lemlist_api") {
    const lemlist = findByProvider(integrations, "lemlist");
    const url = joinUrl(LEMLIST, String(args.path || ""), "api.lemlist.com");
    return providerRequest(url, method, lemlistHeaders(lemlist.apiKey), args.body);
  }

  if (name === "custom_api_request") {
    const label = String(args.integration || "").toLowerCase();
    const integration = integrations.find(
      (item) => item.provider === "other" && item.name.toLowerCase() === label,
    );
    if (!integration) {
      throw new Error(`No custom API named "${args.integration}"`);
    }
    const path = String(args.path || "");
    const resolvedBase =
      normalizeCustomBaseUrl(integration.name, integration.baseUrl || "") ||
      integration.baseUrl ||
      "";
    let url = path.startsWith("http")
      ? path
      : `${resolvedBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
    if (!url.startsWith("http")) {
      throw new Error(
        "Provide a full URL or set a base URL on this integration (MailBluster: https://api.mailbluster.com)",
      );
    }
    if (looksLikeQueryApiKeyAuth(integration)) {
      url = withQueryApiKey(url, integration.apiKey);
    }
    context.secretsUsed?.push(integration.apiKey);
    context.onStatus?.(`Calling ${integration.name}…`);
    const init: RequestInit = {
      method,
      headers: otherHeaders({
        ...integration,
        baseUrl: resolvedBase || integration.baseUrl,
        authType: resolveCustomAuthType(integration),
      }),
    };
    if (args.body && method !== "GET") {
      init.body = encodeBody(args.body);
    }
    const data = await requestJson(url, init);
    return clip(data);
  }

  if (name === "notion_search") {
    const notion = findByProvider(integrations, "notion");
    if (!notion) throw new Error("Connect Notion first (use the Connect Notion button)");
    context.onStatus?.("Searching Notion…");
    const query = String(args.query || "").trim();
    const pageSize = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    const data = (await notionRequest(notion.apiKey, "POST", "/v1/search", {
      query: query || undefined,
      page_size: pageSize,
    })) as {
      results?: Array<{
        id?: string;
        object?: string;
        url?: string;
        properties?: Record<string, unknown>;
        title?: Array<{ plain_text?: string }>;
      }>;
    };
    const results = (data.results || []).map((item) => {
      const titleProp = item.properties?.title as
        | { title?: Array<{ plain_text?: string }> }
        | undefined;
      const nameProp = item.properties?.Name as
        | { title?: Array<{ plain_text?: string }> }
        | undefined;
      const title =
        titleProp?.title?.map((t) => t.plain_text || "").join("") ||
        nameProp?.title?.map((t) => t.plain_text || "").join("") ||
        item.title?.map((t) => t.plain_text || "").join("") ||
        "(untitled)";
      return {
        id: item.id,
        type: item.object,
        title: title || "(untitled)",
        url: item.url,
      };
    });
    return clip({ count: results.length, results });
  }

  if (name === "notion_create_page") {
    const notion = findByProvider(integrations, "notion");
    if (!notion) throw new Error("Connect Notion first (use the Connect Notion button)");
    const parentId = String(args.parent_page_id || args.parentPageId || "").trim();
    const title = String(args.title || "").trim();
    if (!parentId) throw new Error("parent_page_id is required");
    if (!title) throw new Error("title is required");
    const content = String(args.content || "").trim();
    context.onStatus?.("Creating a Notion page…");
    const children = content
      ? [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content: content.slice(0, 1900) } }],
            },
          },
        ]
      : undefined;
    const data = await notionRequest(notion.apiKey, "POST", "/v1/pages", {
      parent: { page_id: parentId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title.slice(0, 200) } }],
        },
      },
      ...(children ? { children } : {}),
    });
    return clip({
      ok: true,
      id: (data as { id?: string }).id,
      url: (data as { url?: string }).url,
      title,
    });
  }

  if (name === "notion_api") {
    const notion = findByProvider(integrations, "notion");
    if (!notion) throw new Error("Connect Notion first (use the Connect Notion button)");
    const path = String(args.path || "");
    if (!path) throw new Error("path is required");
    context.onStatus?.("Calling Notion…");
    const data = await notionRequest(
      notion.apiKey,
      method,
      path,
      args.body === undefined ? undefined : args.body,
    );
    return clip(data);
  }

  throw new Error(`Unknown tool ${name}`);
}

export async function validateIntegration(input: {
  provider: Provider;
  apiKey: string;
  baseUrl?: string;
  authType?: AuthType;
}): Promise<{ mcpUrl?: string }> {
  if (input.provider === "attio") {
    await requestJson(`${ATTIO}/v2/objects`, {
      headers: attioHeaders(input.apiKey),
    });
    return {};
  }
  if (input.provider === "brevo") {
    try {
      await requestJson(`${BREVO}/v3/account`, {
        headers: brevoHeaders(input.apiKey),
      });
      return { mcpUrl: "" };
    } catch {
      await validateBrevoMcp(input.apiKey, BREVO_MCP_DEFAULT);
      return { mcpUrl: BREVO_MCP_DEFAULT };
    }
  }
  if (input.provider === "lemlist") {
    await requestJson(`${LEMLIST}/api/campaigns?limit=1&offset=0`, {
      headers: lemlistHeaders(input.apiKey),
    });
    return {};
  }
  if (input.provider === "notion") {
    await notionRequest(input.apiKey, "GET", "/v1/users/me");
    return {};
  }
  if (input.baseUrl) {
    const probe: StoredIntegration = {
      _id: "probe",
      provider: "other",
      name: "probe",
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      authType: input.authType ?? "bearer",
    };
    try {
      await requestJson(input.baseUrl.replace(/\/$/, ""), {
        headers: otherHeaders(probe),
      });
    } catch {
      // Custom APIs often reject a bare GET on the root. Key is still stored.
    }
  }
  return {};
}
