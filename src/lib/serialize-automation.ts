import { getAppOrigin } from "@/lib/html-shares";

export type SyncRecipe = {
  pollPath: string;
  method?: "GET" | "POST";
  body?: unknown;
  /** Dot path to the array of people/leads, e.g. "data.leads" or "leads". */
  itemsPath?: string;
  emailField?: string;
  nameField?: string;
  stageField?: string;
  defaultStage?: string;
  /** Map raw status values → Attio stage names. */
  stageMap?: Record<string, string>;
  /** Dot path to a status/completion field on the poll response. */
  completedPath?: string;
  /** If the completedPath value matches one of these (case-insensitive), the job completes. */
  completedValues?: string[];
  /** Unified Portal: drip | oneone */
  campaignKind?: "drip" | "oneone" | string;
  /** Unified Portal: watch every campaign (updatedSince + webhooks). */
  watchAll?: boolean;
};

export type AutomationSourceProvider = "lemlist" | "brevo" | "other";

export type AutomationDTO = {
  _id: string;
  type: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  title: string;
  sourceProvider: AutomationSourceProvider;
  sourceIntegrationName: string;
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
  intervalMinutes: number;
  recipe: SyncRecipe | null;
  watchAll: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
  nextRunAt: string;
  lastRunAt: string;
  lastSummary: string;
  runCount: number;
  error: string;
};

function serializeRecipe(raw: unknown): SyncRecipe | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pollPath = String(r.pollPath || "").trim();
  if (!pollPath && !r.campaignKind && !r.watchAll) return null;
  const stageMapRaw = r.stageMap;
  let stageMap: Record<string, string> | undefined;
  if (stageMapRaw && typeof stageMapRaw === "object") {
    stageMap = {};
    for (const [key, value] of Object.entries(stageMapRaw as Record<string, unknown>)) {
      stageMap[key] = String(value ?? "");
    }
  }
  const method = String(r.method || "GET").toUpperCase();
  const kind = String(r.campaignKind || "").toLowerCase();
  return {
    pollPath: pollPath || "/api/campaigns/process-due",
    method: method === "POST" ? "POST" : "GET",
    body: r.body,
    itemsPath: String(r.itemsPath || "").trim() || undefined,
    emailField: String(r.emailField || "").trim() || undefined,
    nameField: String(r.nameField || "").trim() || undefined,
    stageField: String(r.stageField || "").trim() || undefined,
    defaultStage: String(r.defaultStage || "").trim() || undefined,
    stageMap,
    completedPath: String(r.completedPath || "").trim() || undefined,
    completedValues: Array.isArray(r.completedValues)
      ? r.completedValues.map((item) => String(item || "").trim()).filter(Boolean)
      : undefined,
    campaignKind: kind === "drip" || kind === "oneone" ? kind : undefined,
    watchAll: Boolean(r.watchAll),
  };
}

export function serializeAutomation(doc: {
  _id: unknown;
  type?: string;
  status: AutomationDTO["status"];
  title: string;
  sourceProvider: string;
  sourceIntegrationName?: string;
  campaignName: string;
  attioList: string;
  stageOpen?: string;
  stageClick?: string;
  stageReply?: string;
  intervalMinutes?: number;
  recipe?: unknown;
  watchAll?: boolean;
  webhookToken?: string;
  webhookSecret?: string;
  nextRunAt?: Date;
  lastRunAt?: Date;
  lastSummary?: string;
  runCount?: number;
  error?: string;
}): AutomationDTO {
  const sourceProvider =
    doc.sourceProvider === "brevo" || doc.sourceProvider === "other"
      ? doc.sourceProvider
      : "lemlist";
  const token = String(doc.webhookToken || "").trim();
  let webhookUrl = "";
  if (token) {
    const origin = getAppOrigin().replace(/\/$/, "");
    webhookUrl = doc.webhookSecret
      ? `${origin}/api/webhooks/unified/${token}`
      : `${origin}/api/webhooks/smartlead/${token}`;
  }
  return {
    _id: String(doc._id),
    type: doc.type || "campaign_to_attio",
    status: doc.status,
    title: doc.title,
    sourceProvider,
    sourceIntegrationName: doc.sourceIntegrationName || "",
    campaignName: doc.campaignName,
    attioList: doc.attioList,
    stageOpen: doc.stageOpen || "open",
    stageClick: doc.stageClick || "click",
    stageReply: doc.stageReply || "hot",
    intervalMinutes: doc.intervalMinutes || 2,
    recipe: serializeRecipe(doc.recipe),
    watchAll: Boolean(doc.watchAll || (doc.recipe as { watchAll?: boolean } | undefined)?.watchAll),
    webhookEnabled: Boolean(token),
    webhookUrl,
    nextRunAt: doc.nextRunAt ? new Date(doc.nextRunAt).toISOString() : "",
    lastRunAt: doc.lastRunAt ? new Date(doc.lastRunAt).toISOString() : "",
    lastSummary: doc.lastSummary || "",
    runCount: doc.runCount || 0,
    error: doc.error || "",
  };
}
