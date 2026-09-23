import type { AuthType } from "@/types/chat";
import { findKnownCustomApi } from "@/lib/known-custom-apis";
import { applyRealEngagementUnifiedPeople } from "@/lib/engagement-filter";

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

async function requestJson(url: string, init: RequestInit, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: init.signal || controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Unified Portal request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type PortalCampaign = {
  id?: string;
  name?: string;
  kind?: string;
  status?: string;
  subject?: string;
  subjectLine?: string;
  emailSubject?: string;
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
  deliveredAt?: string;
  sentAt?: string;
  sendAt?: string;
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
      const subject = String(
        match.subject || match.subjectLine || match.emailSubject || "",
      ).trim();
      return {
        id: String(match.id),
        name: String(match.name || campaignName),
        kind: (match.kind || kind) as "drip" | "oneone",
        status: String(match.status || "").toLowerCase(),
        subject,
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
      120_000,
    ),
  );
}

export type UnifiedSyncPerson = {
  email: string;
  name: string;
  stage: string;
  sentAt?: string;
  openedAt?: string;
  clickedAt?: string;
};

function pickTime(person: PortalRecipient, keys: (keyof PortalRecipient)[]) {
  for (const key of keys) {
    const value = String(person[key] || "").trim();
    if (value) return value;
  }
  return "";
}

/** Soft-fail helper so one slow Portal filter cannot kill the whole Attio sync. */
async function fetchRecipientsSafe(
  apiKey: string,
  baseUrl: string | undefined,
  campaignId: string,
  kind: string,
  filter: "audience" | "delivered" | "opens" | "clicks" | "unsubscribes",
) {
  try {
    return await fetchRecipients(apiKey, baseUrl, campaignId, kind, filter);
  } catch {
    return [] as PortalRecipient[];
  }
}

export async function collectUnifiedPortalPeople(input: {
  apiKey: string;
  baseUrl?: string;
  campaignId: string;
  kind: string;
  stageProspect?: string;
  stageOpen: string;
  stageClick: string;
  stageReply?: string;
  /** When true, only count open/click ≥45s after send/delivery. */
  realEngagement?: boolean;
}) {
  const stageProspect = input.stageProspect || "Prospect";
  // Prospect / Open / Click only — skip unsubscribes (Portal often hangs on that filter).
  const [delivered, opens, clicks] = await Promise.all([
    fetchRecipientsSafe(input.apiKey, input.baseUrl, input.campaignId, input.kind, "delivered").then(
      async (rows) => {
        if (rows.length) return rows;
        return fetchRecipientsSafe(
          input.apiKey,
          input.baseUrl,
          input.campaignId,
          input.kind,
          "audience",
        );
      },
    ),
    fetchRecipientsSafe(input.apiKey, input.baseUrl, input.campaignId, input.kind, "opens"),
    fetchRecipientsSafe(input.apiKey, input.baseUrl, input.campaignId, input.kind, "clicks"),
  ]);

  const byEmail = new Map<string, UnifiedSyncPerson>();

  const upsert = (
    person: PortalRecipient,
    stage: string,
    patch: Partial<UnifiedSyncPerson>,
  ) => {
    const email = String(person.email || "")
      .trim()
      .toLowerCase();
    if (!email.includes("@")) return;
    const existing = byEmail.get(email);
    const name = String(person.fullName || existing?.name || "").trim();
    byEmail.set(email, {
      email,
      name,
      stage,
      sentAt:
        patch.sentAt ||
        existing?.sentAt ||
        pickTime(person, ["deliveredAt", "sentAt", "sendAt"]),
      openedAt: patch.openedAt || existing?.openedAt || pickTime(person, ["openedAt"]),
      clickedAt: patch.clickedAt || existing?.clickedAt || pickTime(person, ["clickedAt"]),
    });
  };

  for (const person of delivered) {
    upsert(person, stageProspect, {
      sentAt: pickTime(person, ["deliveredAt", "sentAt", "sendAt"]),
    });
  }
  for (const person of opens) {
    upsert(person, input.stageOpen, {
      openedAt: pickTime(person, ["openedAt"]),
    });
  }
  for (const person of clicks) {
    upsert(person, input.stageClick, {
      clickedAt: pickTime(person, ["clickedAt"]),
      openedAt: pickTime(person, ["openedAt"]),
    });
  }

  let people = [...byEmail.values()];
  if (input.realEngagement) {
    people = applyRealEngagementUnifiedPeople(people, {
      prospect: stageProspect,
      open: input.stageOpen,
      click: input.stageClick,
    });
  }

  return {
    people,
    counts: {
      delivered: delivered.length,
      opens: opens.length,
      clicks: clicks.length,
      unsubscribed: 0,
    },
  };
}

export function unifiedPortalConnectHint() {
  const known = findKnownCustomApi("unified portal");
  return known
    ? `Connect as custom API (other): base ${known.baseUrl}; Authorization Bearer up_live_… key from Portal → Integrations.`
    : `Connect Unified Portal as custom API with base ${UNIFIED_PORTAL_BASE} and Bearer up_live_… API key.`;
}

export type UnifiedPortalAuth = { authType: AuthType; baseUrl: string };
