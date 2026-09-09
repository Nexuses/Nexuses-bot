import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { getAppOrigin } from "@/lib/html-shares";
import {
  collectUnifiedPortalPeople,
  driveUnifiedPortalProcessDue,
  isUnifiedPortal,
  UNIFIED_PORTAL_BASE,
  unifiedPortalBaseUrl,
  unifiedPortalHeaders,
} from "@/lib/unified-portal";

export { isUnifiedPortal, UNIFIED_PORTAL_BASE };

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

export type UnifiedCampaignSummary = {
  id: string;
  name: string;
  kind: "drip" | "oneone";
  status: string;
  updatedAt?: string;
  createdAt?: string;
};

function asCampaignList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  return [];
}

/** List campaigns, optionally filtered by updatedSince (ISO). Tries both kinds when kind omitted. */
export async function listUnifiedCampaignsSince(input: {
  apiKey: string;
  baseUrl?: string;
  updatedSince?: string;
  kind?: "drip" | "oneone";
}) {
  const base = unifiedPortalBaseUrl(input.baseUrl);
  const headers = unifiedPortalHeaders(input.apiKey);
  const kinds = input.kind ? [input.kind] : (["drip", "oneone"] as const);
  const out: UnifiedCampaignSummary[] = [];

  for (const kind of kinds) {
    const params = new URLSearchParams({ kind });
    if (input.updatedSince) params.set("updatedSince", input.updatedSince);
    const data = await requestJson(`${base}/api/campaigns?${params}`, { headers });
    for (const item of asCampaignList(data)) {
      const id = String(item.id || "").trim();
      if (!id) continue;
      out.push({
        id,
        name: String(item.name || id),
        kind: (String(item.kind || kind).toLowerCase() === "oneone" ? "oneone" : "drip") as
          | "drip"
          | "oneone",
        status: String(item.status || "").toLowerCase(),
        updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
        createdAt: item.createdAt ? String(item.createdAt) : undefined,
      });
    }
  }
  return out;
}

export function makeWebhookReceiveToken() {
  return randomBytes(18).toString("base64url");
}

export function verifyUnifiedWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string;
}) {
  const header = String(input.signatureHeader || "").trim();
  const provided = header.replace(/^sha256=/i, "").trim();
  if (!provided || !input.secret) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function registerUnifiedPortalWebhook(input: {
  apiKey: string;
  baseUrl?: string;
  receiveToken: string;
  events?: string[];
}) {
  const origin = getAppOrigin();
  if (!origin || /localhost|127\.0\.0\.1/i.test(origin)) {
    throw new Error(
      "Set APP_URL to your public HTTPS bot URL (e.g. https://bot.nexuses-online.com) before registering Unified webhooks. Until then, updatedSince polling still works.",
    );
  }
  const url = `${origin.replace(/\/$/, "")}/api/webhooks/unified/${input.receiveToken}`;
  const base = unifiedPortalBaseUrl(input.baseUrl);
  const headers = unifiedPortalHeaders(input.apiKey);
  const data = (await requestJson(`${base}/api/integrations/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url,
      events: input.events || [
        "campaign.created",
        "campaign.launched",
        "send.opened",
        "send.clicked",
      ],
    }),
  })) as {
    webhook?: { id?: string };
    secret?: string;
  };

  const secret = String(data?.secret || "").trim();
  const portalWebhookId = String(data?.webhook?.id || "").trim();
  if (!secret) throw new Error("Unified Portal did not return a webhook signing secret");
  return { url, secret, portalWebhookId };
}

export async function deleteUnifiedPortalWebhook(input: {
  apiKey: string;
  baseUrl?: string;
  portalWebhookId: string;
}) {
  if (!input.portalWebhookId) return;
  const base = unifiedPortalBaseUrl(input.baseUrl);
  const headers = unifiedPortalHeaders(input.apiKey);
  try {
    await requestJson(
      `${base}/api/integrations/webhooks/${encodeURIComponent(input.portalWebhookId)}`,
      { method: "DELETE", headers },
    );
  } catch {
    // best-effort revoke
  }
}

export type UnifiedWebhookPayload = {
  id?: string;
  type?: string;
  createdAt?: string;
  projectId?: string;
  data?: {
    campaignId?: string;
    kind?: string;
    name?: string;
    status?: string;
    email?: string;
    fullName?: string;
    sendId?: string;
    url?: string;
    mode?: string;
    recipients?: number;
  };
};

export function peopleFromUnifiedWebhookEvent(
  payload: UnifiedWebhookPayload,
  stages: { open: string; click: string },
): { email: string; name: string; stage: string }[] {
  const type = String(payload.type || "").toLowerCase();
  const email = String(payload.data?.email || "")
    .trim()
    .toLowerCase();
  if (!email.includes("@")) return [];
  const name = String(payload.data?.fullName || "").trim();
  if (type === "send.clicked") {
    return [{ email, name, stage: stages.click }];
  }
  if (type === "send.opened") {
    return [{ email, name, stage: stages.open }];
  }
  return [];
}

export async function syncUnifiedCampaignEngagement(input: {
  apiKey: string;
  baseUrl?: string;
  campaignId: string;
  kind: string;
  stageOpen: string;
  stageClick: string;
  stageReply?: string;
}) {
  await driveUnifiedPortalProcessDue(input.apiKey, input.baseUrl, 4);
  return collectUnifiedPortalPeople({
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    campaignId: input.campaignId,
    kind: input.kind,
    stageOpen: input.stageOpen,
    stageClick: input.stageClick,
    stageReply: input.stageReply,
  });
}
