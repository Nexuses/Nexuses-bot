import { getAppOrigin } from "@/lib/html-shares";

export const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";

export function isSmartLead(input: { name?: string; baseUrl?: string }) {
  const hay = `${input.name || ""} ${input.baseUrl || ""}`;
  return /smartlead/i.test(hay);
}

export function smartleadBaseUrl(baseUrl?: string) {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  if (trimmed) return trimmed;
  return SMARTLEAD_BASE;
}

function withApiKey(url: string, apiKey: string) {
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

export type SmartleadWebhookPayload = Record<string, unknown>;

/** Normalize EMAIL_OPEN vs EMAIL_OPENED, flat vs nested docs. */
export function normalizeSmartleadEvent(payload: SmartleadWebhookPayload) {
  const nested = payload.event && typeof payload.event === "object" ? (payload.event as Record<string, unknown>) : null;
  const rawType = String(
    payload.event_type || payload.eventType || payload.event || nested?.type || "",
  )
    .trim()
    .toUpperCase();

  const lead =
    payload.lead && typeof payload.lead === "object"
      ? (payload.lead as Record<string, unknown>)
      : null;

  const email = String(
    payload.to_email ||
      payload.toEmail ||
      payload.lead_email ||
      payload.email ||
      lead?.email ||
      payload.to ||
      "",
  )
    .trim()
    .toLowerCase();

  const name = String(
    payload.to_name ||
      payload.toName ||
      payload.lead_name ||
      payload.name ||
      lead?.first_name ||
      [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") ||
      "",
  ).trim();

  const campaignName = String(
    payload.campaign_name || payload.campaignName || nested?.campaign_name || "",
  ).trim();
  const campaignId = String(
    payload.campaign_id || payload.campaignId || nested?.campaign_id || "",
  ).trim();

  return { rawType, email, name, campaignName, campaignId };
}

export function stageFromSmartleadEvent(
  rawType: string,
  stages: { open: string; click: string; reply: string; sent?: string },
): string | null {
  const t = rawType.replace(/^EMAIL_/, "");
  if (
    rawType === "EMAIL_SENT" ||
    rawType === "FIRST_EMAIL_SENT" ||
    t === "SENT" ||
    rawType === "EMAIL_SENT"
  ) {
    return stages.sent || "sent";
  }
  if (rawType === "EMAIL_OPEN" || rawType === "EMAIL_OPENED" || t === "OPEN" || t === "OPENED") {
    return stages.open;
  }
  if (
    rawType === "EMAIL_LINK_CLICK" ||
    rawType === "EMAIL_CLICKED" ||
    rawType === "EMAIL_CLICK" ||
    t === "LINK_CLICK" ||
    t === "CLICKED" ||
    t === "CLICK"
  ) {
    return stages.click;
  }
  if (rawType === "EMAIL_REPLY" || rawType === "EMAIL_REPLIED" || t === "REPLY" || t === "REPLIED") {
    return stages.reply;
  }
  if (rawType === "EMAIL_BOUNCE" || rawType === "EMAIL_BOUNCED" || t === "BOUNCE" || t === "BOUNCED") {
    return "bounced";
  }
  if (rawType === "LEAD_UNSUBSCRIBED" || t === "UNSUBSCRIBED") {
    return "unsubscribed";
  }
  return null;
}

export function smartleadWebhookPublicUrl(token: string) {
  const origin = getAppOrigin().replace(/\/$/, "");
  return `${origin}/api/webhooks/smartlead/${token}`;
}

/** Best-effort register via SmartLead API. User can also paste the URL in the dashboard. */
export async function registerSmartleadWebhook(input: {
  apiKey: string;
  baseUrl?: string;
  webhookUrl: string;
  name?: string;
  campaignId?: string | number;
}) {
  const base = smartleadBaseUrl(input.baseUrl);
  const url = withApiKey(`${base}/webhook/create`, input.apiKey);
  const body: Record<string, unknown> = {
    name: input.name || "Nexuses Attio sync",
    webhook_url: input.webhookUrl,
    event_type_map: {
      EMAIL_SENT: true,
      FIRST_EMAIL_SENT: true,
      EMAIL_OPEN: true,
      EMAIL_LINK_CLICK: true,
      EMAIL_REPLY: true,
      EMAIL_BOUNCE: true,
      LEAD_UNSUBSCRIBED: true,
    },
  };
  if (input.campaignId) {
    body.email_campaign_id = Number(input.campaignId) || input.campaignId;
    body.association_type = "campaign";
  } else {
    // Client/global-style when SmartLead accepts it; otherwise user pastes URL in UI.
    body.association_type = "client";
  }

  const data = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  return data;
}
