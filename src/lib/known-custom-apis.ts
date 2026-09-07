import type { AuthType } from "@/types/chat";

export type KnownCustomApi = {
  match: RegExp;
  baseUrl: string;
  authType: AuthType;
  docsUrl: string;
  /** Honest product limits the agent must not invent around. */
  limits: string;
  pathHints: string;
};

/** Built-in knowledge for common “Other” APIs so the bot does not guess. */
export const KNOWN_CUSTOM_APIS: KnownCustomApi[] = [
  {
    match: /smartlead/i,
    baseUrl: "https://server.smartlead.ai/api/v1",
    authType: "query",
    docsUrl: "https://api.smartlead.ai/authentication",
    limits: "Campaigns, leads, and analytics are available via REST with ?api_key=.",
    pathHints: "Examples: GET /campaigns, GET /campaigns/{id}/analytics",
  },
  {
    match: /mailbluster|mail.?bluster/i,
    baseUrl: "https://api.mailbluster.com",
    authType: "authorization",
    docsUrl: "https://app.mailbluster.com/api-doc/getting-started",
    limits:
      "Developer API covers Leads, Fields, Products, and Orders ONLY. It does NOT expose email campaigns, opens, clicks, or send stats. Do not invent campaign endpoints. Tell the user campaign reports are not available via MailBluster API — use Brevo/Lemlist/SmartLead if they need campaign analytics.",
    pathHints: "Examples: GET /api/leads/{hash}, POST /api/leads — Host api.mailbluster.com",
  },
];

export function findKnownCustomApi(nameOrUrl: string) {
  const hay = nameOrUrl || "";
  return KNOWN_CUSTOM_APIS.find((item) => item.match.test(hay)) || null;
}

export function knownCustomApiGuide(integrations: { name: string; baseUrl?: string }[]) {
  const lines: string[] = [];
  for (const item of integrations) {
    const known = findKnownCustomApi(`${item.name} ${item.baseUrl || ""}`);
    if (!known) continue;
    lines.push(
      `${item.name}: base ${known.baseUrl}; auth=${known.authType}; docs ${known.docsUrl}. ${known.limits} ${known.pathHints}`,
    );
  }
  return lines.join("\n");
}
