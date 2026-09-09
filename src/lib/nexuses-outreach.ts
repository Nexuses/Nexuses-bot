/** Nexuses Outreach (1-1) Integration API — https://outreachcampaign.nexuses.xyz */

export const OUTREACH_BASE = "https://outreachcampaign.nexuses.xyz";

export function isNexusesOutreach(input: { name?: string; baseUrl?: string }) {
  const hay = `${input.name || ""} ${input.baseUrl || ""}`;
  return /outreach|1-?1\s*tool|nexuses\s*1-?1|outreachcampaign\.nexuses/i.test(hay);
}

export function outreachBaseUrl(baseUrl?: string) {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  if (trimmed) return trimmed;
  return OUTREACH_BASE;
}

export function outreachHeaders(apiKey: string): Record<string, string> {
  let key = String(apiKey || "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  return {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
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

type OutreachCampaign = {
  id?: string;
  name?: string;
  status?: string;
};

type StatItem = {
  email?: string;
  at?: string;
  stepId?: string;
  url?: string;
  reason?: string;
};

function asCampaigns(data: unknown): OutreachCampaign[] {
  if (Array.isArray(data)) return data as OutreachCampaign[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.campaigns)) return record.campaigns as OutreachCampaign[];
  }
  return [];
}

function asItems(data: unknown): StatItem[] {
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.items)) return record.items as StatItem[];
  return [];
}

/** Prefer /api/v1 — session /api/* routes 401 with API keys. */
export async function resolveOutreachCampaign(
  apiKey: string,
  baseUrl: string | undefined,
  campaignName: string,
) {
  const base = outreachBaseUrl(baseUrl);
  const headers = outreachHeaders(apiKey);
  const list = asCampaigns(await requestJson(`${base}/api/v1/campaigns`, { headers }));
  const match =
    list.find((item) => String(item.name || "").toLowerCase() === campaignName.toLowerCase()) ||
    list.find((item) =>
      String(item.name || "")
        .toLowerCase()
        .includes(campaignName.toLowerCase()),
    );
  if (!match?.id) {
    throw new Error(
      `Outreach campaign "${campaignName}" not found. List with GET /api/v1/campaigns.`,
    );
  }
  return {
    id: String(match.id),
    name: String(match.name || campaignName),
    status: String(match.status || "").toLowerCase(),
  };
}

export async function collectOutreachPeople(input: {
  apiKey: string;
  baseUrl?: string;
  campaignId: string;
  stageOpen: string;
  stageClick: string;
  stageReply?: string;
}) {
  const base = outreachBaseUrl(input.baseUrl);
  const headers = outreachHeaders(input.apiKey);
  const id = encodeURIComponent(input.campaignId);

  const [opened, clicked, bounced] = await Promise.all([
    requestJson(`${base}/api/v1/campaigns/${id}/stats?kind=opened`, { headers }),
    requestJson(`${base}/api/v1/campaigns/${id}/stats?kind=clicked`, { headers }),
    requestJson(`${base}/api/v1/campaigns/${id}/stats?kind=bounced`, { headers }),
  ]);

  const openItems = asItems(opened);
  const clickItems = asItems(clicked);
  const bounceItems = asItems(bounced);

  const byEmail = new Map<string, { email: string; name: string; stage: string }>();
  for (const item of openItems) {
    const email = String(item.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, { email, name: "", stage: input.stageOpen });
  }
  for (const item of clickItems) {
    const email = String(item.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, { email, name: "", stage: input.stageClick });
  }
  for (const item of bounceItems) {
    const email = String(item.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, {
      email,
      name: "",
      stage: input.stageReply || "bounced",
    });
  }

  return {
    people: [...byEmail.values()],
    counts: {
      opens: openItems.length,
      clicks: clickItems.length,
      bounced: bounceItems.length,
    },
  };
}

export async function outreachOverview(apiKey: string, baseUrl?: string) {
  const base = outreachBaseUrl(baseUrl);
  return requestJson(`${base}/api/v1/overview`, {
    headers: outreachHeaders(apiKey),
  });
}
