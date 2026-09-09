import type { AuthType } from "@/types/chat";
import { findKnownCustomApi } from "@/lib/known-custom-apis";

export const UNIFIED_PORTAL_BASE = "https://unified.nexuses.xyz";

export function isUnifiedPortal(input: { name?: string; baseUrl?: string }) {
  const hay = `${input.name || ""} ${input.baseUrl || ""}`;
  return /unified(\s*portal)?|unified\.nexuses\.xyz/i.test(hay);
}

export function unifiedPortalBaseUrl(baseUrl?: string) {
  const trimmed = String(baseUrl || "")
    .trim()
    .replace(/\/$/, "");
  if (trimmed) return trimmed;
  return UNIFIED_PORTAL_BASE;
}

export function unifiedPortalHeaders(apiKey: string): Record<string, string> {
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

type PortalCampaign = {
  id?: string;
  name?: string;
  kind?: string;
  status?: string;
  opens?: number;
  clicks?: number;
  recipients?: number;
  delivered?: number;
  unsubscribed?: number;
};

type PortalRecipient = {
  email?: string;
  fullName?: string;
  status?: string;
  openedAt?: string;
  clickedAt?: string;
  unsubscribedAt?: string;
};

function asCampaigns(data: unknown): PortalCampaign[] {
  if (Array.isArray(data)) return data as PortalCampaign[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["campaigns", "data", "items"]) {
      if (Array.isArray(record[key])) return record[key] as PortalCampaign[];
    }
  }
  return [];
}

function asRecipients(data: unknown): PortalRecipient[] {
  if (Array.isArray(data)) return data as PortalRecipient[];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["recipients", "data", "items"]) {
      if (Array.isArray(record[key])) return record[key] as PortalRecipient[];
    }
  }
  return [];
}

export async function resolveUnifiedPortalCampaign(
  apiKey: string,
  baseUrl: string | undefined,
  campaignName: string,
  kindHint?: string,
) {
  const base = unifiedPortalBaseUrl(baseUrl);
  const headers = unifiedPortalHeaders(apiKey);
  const kinds =
    kindHint === "drip" || kindHint === "oneone"
      ? [kindHint]
      : (["oneone", "drip"] as const);

  for (const kind of kinds) {
    const list = asCampaigns(
      await requestJson(`${base}/api/campaigns?kind=${kind}`, { headers }),
    );
    const match =
      list.find((item) => String(item.name || "").toLowerCase() === campaignName.toLowerCase()) ||
      list.find((item) =>
        String(item.name || "")
          .toLowerCase()
          .includes(campaignName.toLowerCase()),
      );
    if (match?.id) {
      return {
        id: String(match.id),
        name: String(match.name || campaignName),
        kind: (match.kind || kind) as "drip" | "oneone",
        status: String(match.status || "").toLowerCase(),
        opens: Number(match.opens) || 0,
        clicks: Number(match.clicks) || 0,
        recipients: Number(match.recipients) || 0,
        delivered: Number(match.delivered) || 0,
        unsubscribed: Number(match.unsubscribed) || 0,
      };
    }
  }
  throw new Error(
    `Unified Portal campaign "${campaignName}" not found. Check the name and kind (drip vs oneone).`,
  );
}

/** Drive portal sends: UI normally polls process-due every ~3s; we batch calls each sync tick. */
export async function driveUnifiedPortalProcessDue(
  apiKey: string,
  baseUrl: string | undefined,
  rounds = 8,
) {
  const base = unifiedPortalBaseUrl(baseUrl);
  const headers = unifiedPortalHeaders(apiKey);
  let lastReports: unknown[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const data = (await requestJson(`${base}/api/campaigns/process-due`, {
      method: "POST",
      headers,
      body: "{}",
    })) as { reports?: unknown[] } | null;
    lastReports = Array.isArray(data?.reports) ? data.reports : [];
    if (!lastReports.length && i > 0) break;
  }
  return lastReports.length;
}

async function fetchRecipients(
  apiKey: string,
  baseUrl: string | undefined,
  campaignId: string,
  kind: string,
  filter: "audience" | "delivered" | "opens" | "clicks" | "unsubscribes",
) {
  const base = unifiedPortalBaseUrl(baseUrl);
  const headers = unifiedPortalHeaders(apiKey);
  return asRecipients(
    await requestJson(
      `${base}/api/campaigns/${encodeURIComponent(campaignId)}/recipients?filter=${filter}&kind=${kind}`,
      { headers },
    ),
  );
}

export async function collectUnifiedPortalPeople(input: {
  apiKey: string;
  baseUrl?: string;
  campaignId: string;
  kind: string;
  stageOpen: string;
  stageClick: string;
  stageReply?: string;
}) {
  const [opens, clicks, unsubs] = await Promise.all([
    fetchRecipients(input.apiKey, input.baseUrl, input.campaignId, input.kind, "opens"),
    fetchRecipients(input.apiKey, input.baseUrl, input.campaignId, input.kind, "clicks"),
    fetchRecipients(input.apiKey, input.baseUrl, input.campaignId, input.kind, "unsubscribes"),
  ]);

  const byEmail = new Map<string, { email: string; name: string; stage: string }>();
  for (const person of opens) {
    const email = String(person.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, {
      email,
      name: String(person.fullName || "").trim(),
      stage: input.stageOpen,
    });
  }
  for (const person of clicks) {
    const email = String(person.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, {
      email,
      name: String(person.fullName || "").trim(),
      stage: input.stageClick,
    });
  }
  // Unsubscribes stay as click/open if already present; otherwise mark open stage label "unsubscribed" only if stageReply used as hot — keep simple: use stageReply or "unsubscribed"
  for (const person of unsubs) {
    const email = String(person.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) continue;
    byEmail.set(email, {
      email,
      name: String(person.fullName || "").trim(),
      stage: input.stageReply || "unsubscribed",
    });
  }

  return {
    people: [...byEmail.values()],
    counts: { opens: opens.length, clicks: clicks.length, unsubscribed: unsubs.length },
  };
}

export function unifiedPortalConnectHint() {
  const known = findKnownCustomApi("unified portal");
  return known
    ? `Connect as custom API (other): base ${known.baseUrl}; Authorization Bearer up_live_… key from Portal → Integrations.`
    : `Connect Unified Portal as custom API with base ${UNIFIED_PORTAL_BASE} and Bearer up_live_… API key.`;
}

export type UnifiedPortalAuth = { authType: AuthType; baseUrl: string };
