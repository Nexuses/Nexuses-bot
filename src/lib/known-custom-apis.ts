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
    match: /unified(\s*portal)?|unified\.nexuses\.xyz/i,
    baseUrl: "https://unified.nexuses.xyz",
    authType: "bearer",
    docsUrl: "https://unified.nexuses.xyz/portal/integrations",
    limits:
      "Auth: Authorization Bearer up_live_… project API key (Integrations). GET /api/auth/me is cookie-only — do not use Bearer there. Always pass ?kind=drip|oneone on campaign id routes. Sends only advance while POST /api/campaigns/process-due is called (no cron). Prefer webhooks (POST /api/integrations/webhooks) for campaign.created/launched and send.opened/clicked; fallback poll GET /api/campaigns?updatedSince=ISO. Portal marketing automations live at /api/automations (separate from Nexuses-bot Attio sync jobs).",
    pathHints:
      "Campaigns: GET/POST /api/campaigns?kind=&updatedSince=, GET/PATCH/DELETE /api/campaigns/{id}?kind=, POST /api/campaigns/launch, POST /api/campaigns/process-due, GET /api/campaigns/stats, GET /api/campaigns/{id}/recipients?filter=&kind=, POST /api/campaigns/{id}/share?kind=. Automations: GET/POST /api/automations, PATCH/DELETE /api/automations/{id}. Webhooks: GET/POST /api/integrations/webhooks, DELETE /api/integrations/webhooks/{id}. CRM: /api/crm/contacts, /api/crm/lists. SMTP: /api/smtp/senders. Keys: /api/integrations/keys.",
  },
  {
    match: /outreach|1-?1\s*tool|nexuses\s*1-?1|outreachcampaign\.nexuses/i,
    baseUrl: "https://outreachcampaign.nexuses.xyz",
    authType: "bearer",
    docsUrl: "https://outreachcampaign.nexuses.xyz",
    limits:
      "Nexuses Outreach (1-1 tool). ALWAYS use /api/v1/... paths with Authorization Bearer nts_… (or X-Api-Key). Never call /api/campaigns or other non-v1 session routes with an API key — those return 401. Do not invent /test or /send-test; use POST /api/v1/campaigns/:id/test-send. Google/Microsoft OAuth senders are dashboard-only. Max 5 API keys per project.",
    pathHints:
      "Health: GET /api/v1/overview. Campaigns: GET/POST /api/v1/campaigns, GET/PUT/DELETE /api/v1/campaigns/:id, POST .../launch, .../pause, .../test-send, GET .../stats?kind=sequence|opened|clicked|bounced|failed. Contacts: GET/POST /api/v1/contacts, PUT/DELETE /api/v1/contacts/:id (?includeRows=1). Senders: GET/POST /api/v1/senders, PATCH/DELETE /api/v1/senders/:id. Unsubscribes: GET/POST/DELETE /api/v1/unsubscribes.",
  },
  {
    match: /smartlead/i,
    baseUrl: "https://server.smartlead.ai/api/v1",
    authType: "query",
    docsUrl: "https://api.smartlead.ai/authentication",
    limits:
      "Auth: ?api_key= on every request (auto-attached). SmartLead REST often does NOT return reliable open/click/sent lists — use webhooks: EMAIL_SENT, EMAIL_OPEN, EMAIL_LINK_CLICK, EMAIL_REPLY, EMAIL_BOUNCE. Nexuses receives them at /api/webhooks/smartlead/{token} and syncs into Attio. Prefer start_campaign_automation with SmartLead + attio_list (campaign name or watch_all).",
    pathHints:
      "REST: GET /campaigns, GET /campaigns/{id}. Webhooks: create via POST /webhook/create or paste URL in SmartLead dashboard. Events: EMAIL_SENT, EMAIL_OPEN, EMAIL_LINK_CLICK, EMAIL_REPLY, EMAIL_BOUNCE, LEAD_UNSUBSCRIBED.",
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
