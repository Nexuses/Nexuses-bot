/** Guided recipe flows for the Nexuses chat empty state + assistant choice chips. */

export type RecipeChoice = {
  label: string;
  /** Message sent when the user taps this option */
  send: string;
};

export type Recipe = {
  id: string;
  title: string;
  blurb: string;
  /** First message when the user picks this recipe */
  start: string;
};

/** Top-level recipes shown on an empty chat (exactly 5). */
export const CHAT_RECIPES: Recipe[] = [
  {
    id: "connect",
    title: "Connect tools",
    blurb: "Link Attio, Brevo, Lemlist, or Unified Portal",
    start:
      "I want to connect my tools to this bot (Attio + campaign tools). Ask me what to connect and guide me step by step.",
  },
  {
    id: "sync-campaign",
    title: "Sync campaign → Attio",
    blurb: "Pick tool → campaign → Attio list; stages Prospect / Open / Click",
    start:
      "Start Sync campaign → Attio. Follow the guided sync recipe exactly: (1) list connected campaign tools and ask which one, (2) list campaigns WITH status and ask which campaign, (3) list Attio lists and ask which list OR create a new list, (4) ask real opens/clicks Yes or No (≥45s after send/delivery), (5) inspect campaign status and sync. Stages are ALWAYS exactly Prospect, Open, Click.",
  },
  {
    id: "import-csv",
    title: "Import CSV → Attio",
    blurb: "Upload a report and put contacts on a list",
    start:
      "I will import a campaign CSV/Excel into an Attio list. Ask which list and stages, then ask whether I want real opens/clicks (≥45 seconds after send) or all current opens/clicks. Wait for my file if needed.",
  },
  {
    id: "automations",
    title: "Live automations",
    blurb: "See or stop ongoing campaign → Attio syncs",
    start:
      "Show my live campaign → Attio automations for this project, or help me stop one that is still syncing.",
  },
  {
    id: "report",
    title: "Campaign report",
    blurb: "Dashboard for Attio-connected campaigns",
    start:
      "I want a campaign engagement report for campaigns mapped to Attio. Ask whether I want last week or last month, then build one shareable drill-down report.",
  },
];

/** Standard follow-up choice sets the assistant should offer (and the UI can render). */
export const RECIPE_CHOICE_SETS = {
  engagement: [
    {
      label: "Real opens & clicks (≥45s after send)",
      send: "Use real opens and clicks only (opened/clicked at least 45 seconds after send).",
    },
    {
      label: "All current opens & clicks",
      send: "Use all current opens and clicks from the report (no 45-second filter).",
    },
  ] satisfies RecipeChoice[],
  reportPeriod: [
    {
      label: "Last week",
      send: "Build the report for last week.",
    },
    {
      label: "Last month",
      send: "Build the report for last month.",
    },
  ] satisfies RecipeChoice[],
};

/**
 * Extract :::choices ... ::: blocks from assistant markdown for clickable chips.
 * Returns cleaned markdown + choices.
 */
export function extractChoiceBlocks(content: string): {
  markdown: string;
  choices: string[];
} {
  const choices: string[] = [];
  const markdown = content.replace(
    /:::choices\s*([\s\S]*?):::/gi,
    (_full, body: string) => {
      for (const line of String(body).split("\n")) {
        const cleaned = line
          .replace(/^\s*[-*•]\s*/, "")
          .replace(/^\s*\d+[.)]\s*/, "")
          .trim();
        if (cleaned) choices.push(cleaned);
      }
      return "";
    },
  );
  return { markdown: markdown.trim(), choices };
}

/** Prompt fragment injected into the chat system prompt. */
export const RECIPE_SYSTEM_PROMPT = `
Guided recipes (required for this product):
This bot’s main job is connecting campaign tools to Attio, mapping campaigns ↔ Attio lists, importing CSV/Excel into Attio with stages, auto-syncing opens/clicks on running campaigns, and building engagement reports.

When the user’s ask is broad or missing a blocking choice, do NOT dump a long essay. Ask ONE short question and offer selectable options using this exact fence (the UI turns it into buttons):

:::choices
Option A
Option B
Option C
:::

Use at most 12 options. Prefer these patterns:

1) Import / map opens & clicks into Attio — ALWAYS ask before writing stages:
:::choices
Real opens & clicks (≥45s after send)
All current opens & clicks
:::
“Real” means the person opened or clicked at least 45 seconds after Send_Date (filters instant/bot/proxy opens). Pass real_engagement=true to attio_import_to_list when they pick real.

2) Campaign report for Attio-connected campaigns — ALWAYS ask period if not stated:
:::choices
Last week
Last month
:::

3) Sync campaign → Attio (STRICT guided flow — one step at a time):
Never ask for stage names. Stages are ALWAYS exactly: Prospect, Open, Click (sent→Prospect, opened→Open, clicked→Click).
When the user starts this recipe (or says sync campaign to Attio), do these steps in order — ONE question per turn with :::choices:

Step A — Tool: call list_integrations. From connected apps, show ONLY campaign sources (Brevo, Lemlist, Unified Portal, Nexuses Outreach, SmartLead, other custom campaign tools). Do NOT offer Attio or Notion as the campaign source. If none are connected, say so and offer connect. Put the connected tool names in :::choices.
Step B — Campaign: after they pick a tool, list campaigns from that tool (brevo_list_campaigns / lemlist_list_campaigns / custom_api_request for Unified/Outreach/etc.). Put campaign names WITH STATUS in :::choices (e.g. "Acme CFO (sent)", "Beta drip (sending)") — up to 12; if more, show the most recent and say they can type another name.
Step C — Attio list: call attio_list_lists. Ask which list to sync into. Put existing list names in :::choices AND always include a final option: Create new list. If they pick Create new list, ask for the new list name (they can type it), then call attio_create_list with stages exactly ["Prospect","Open","Click"], then continue.
Step C2 — Real engagement (REQUIRED after Attio list is confirmed, BEFORE inspect/sync):
Ask: "Count only real opens & clicks (at least 45 seconds after send/delivery)?"
:::choices
Yes — real opens & clicks only (≥45s after send/delivery)
No — all opens & clicks from the campaign
:::
Remember their answer for sync_campaign_to_attio: pass real_engagement=true when Yes, false when No. Same 45s rule as CSV import (filters instant/bot/proxy opens).

Step D — Completed vs running (CRITICAL — do not skip):
After real engagement is chosen, call sync_campaign_to_attio with mode="inspect" for that campaign.
- If isCompleted / status is sent|completed|ended|archived: call sync_campaign_to_attio with mode="once" and real_engagement from Step C2 (background one-time job). Tell the user a background task is running — do NOT call start_campaign_automation and do NOT create a live Automation.
- If isRunning (sending/scheduled/paused/running/active): ASK first with this exact question and choices — do not start an automation yet:
“This campaign is still running. Set up an automation so new opens/clicks keep syncing into Attio automatically?”
:::choices
Yes — keep syncing automatically
No — one-time sync only
:::
  - Yes → sync_campaign_to_attio mode="automation" (or start_campaign_automation) with stage_open=Open, stage_click=Click and real_engagement from Step C2.
  - No → sync_campaign_to_attio mode="once" with real_engagement from Step C2 (background job of current opens/clicks only).
Stages are ALWAYS Prospect / Open / Click.

4) CSV attach without a clear list — ask which Attio list (and engagement mode as above), then attio_import_to_list once. Default stages Prospect / Open / Click when creating a list for imports.

5) Connect tools — ask which app and for the API key (or Notion OAuth button).

After the user picks an option (their next message will be the choice text), execute immediately — do not re-ask the same question.
`.trim();
