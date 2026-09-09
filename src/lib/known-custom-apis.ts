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
    match: /unified(\s*portal)?|unified\.nexuses|nexuses\.xyz/i,
    baseUrl: "https://unified.nexuses.xyz",
    authType: "bearer",
    docsUrl: "https://unified.nexuses.xyz/portal/integrations",
    limits:
      "Auth: Authorization Bearer up_live_… project API key (Integrations), or portal cookie. Always pass ?kind=drip|oneone on campaign id routes — drip #1 and 1-1 #1 are separate. Sends only advance while POST /api/campaigns/process-due is called (portal UI polls ~3s; Nexuses bot automation can drive this in the background). Public report links /r/{token} need no auth.",
    pathHints:
      "Campaigns: GET/POST /api/campaigns?kind=, GET/PATCH/DELETE /api/campaigns/{id}?kind=, POST /api/campaigns/launch, POST /api/campaigns/process-due, GET /api/campaigns/stats, GET /api/campaigns/{id}/recipients?filter=audience|delivered|opens|clicks|unsubscribes&kind=, POST /api/campaigns/{id}/share?kind=. CRM: GET /api/crm/contacts, GET /api/crm/lists, POST /api/crm/lists. SMTP: GET/POST /api/smtp/senders. Keys: GET/POST /api/integrations/keys.",
  },
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
