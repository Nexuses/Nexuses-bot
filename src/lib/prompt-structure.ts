import { complete, type LlmMessage } from "@/lib/llm";

export type StructuredPrompt = {
  ready: boolean;
  goal: string;
  apps: string[];
  data: string;
  output: string;
  constraints: string;
  questions: string[];
  brief: string;
};

function looksLikeWork(text: string) {
  return /\b(create|add|make|update|delete|remove|send|find|search|list|get|put|connect|set up|setup|build|insert|change|assign|move|keep|continue|auto[- ]?update|sync|import|export|report|dashboard|share|pull|fetch|generate|who opened|who clicked)\b/i.test(
    text,
  );
}

function looksLikeClarificationReply(text: string) {
  return /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|proceed|continue|no,?\s|use |brevo|lemlist|attio|notion|last week|this week|hr |hot|cold|engage|prospect)/i.test(
    text.trim(),
  );
}

export function needsPromptStructuring(input: {
  text: string;
  fileCount: number;
  historyCount?: number;
  lastAssistantText?: string;
}) {
  const text = input.text.trim();
  if (!text && input.fileCount === 0) return false;

  // Follow-ups in an existing thread: skip the clarifier — main agent has history.
  if ((input.historyCount || 0) >= 2 && text.length < 220 && input.fileCount === 0) {
    return false;
  }

  // User is answering our clarifying questions — don't ask again; execute.
  if (
    input.lastAssistantText &&
    /clarif|quick question|before i (can )?(start|continue|build|pull)|i want to make sure|need (a bit )?more|which (one|tool|app|campaign|list|object)/i.test(
      input.lastAssistantText,
    ) &&
    (looksLikeClarificationReply(text) || text.length > 0)
  ) {
    return false;
  }

  if (input.fileCount > 0) return true;
  if (looksLikeWork(text)) return true;
  if (text.length >= 140) return true;
  return false;
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function buildBrief(parts: {
  goal: string;
  apps: string[];
  data: string;
  output: string;
  constraints: string;
  original: string;
}) {
  const lines = [
    "Structured request (execute this; prefer this over a messy original wording):",
    parts.goal ? `- Goal: ${parts.goal}` : "",
    parts.apps.length ? `- Apps / tools: ${parts.apps.join(", ")}` : "",
    parts.data ? `- Data needed: ${parts.data}` : "",
    parts.output ? `- Deliverable: ${parts.output}` : "",
    parts.constraints ? `- Constraints: ${parts.constraints}` : "",
    `- Original user message: ${parts.original.slice(0, 1500)}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function fallbackReady(original: string): StructuredPrompt {
  return {
    ready: true,
    goal: original.slice(0, 200),
    apps: [],
    data: "",
    output: "",
    constraints: "",
    questions: [],
    brief: buildBrief({
      goal: original.slice(0, 200),
      apps: [],
      data: "",
      output: "",
      constraints: "",
      original,
    }),
  };
}

/**
 * Rewrite messy user asks into a clear brief for the main agent.
 * Prefer ready=true whenever chat history or defaults can fill gaps.
 * Clarifying questions are rare and never block an active thread.
 */
export async function structureUserPrompt(input: {
  text: string;
  connected: string[];
  fileNames?: string[];
  projectName?: string;
  recentHistory?: { role: string; content: string }[];
}): Promise<StructuredPrompt> {
  const original = input.text.trim() || "(files attached; infer task from files + history)";
  const history = (input.recentHistory || [])
    .slice(-8)
    .map((m) => `${m.role}: ${String(m.content || "").slice(0, 500)}`)
    .join("\n");
  const hasHistory = (input.recentHistory || []).length > 0;

  const system = `You rewrite user requests into a clear brief for Nexuses (Attio / Brevo / Lemlist / SmartLead / dashboards).

Return ONLY compact JSON:
{
  "ready": boolean,
  "goal": "one sentence",
  "apps": ["attio"],
  "data": "what data to use or fetch",
  "output": "what to deliver",
  "constraints": "list names, stage names, campaign names from history",
  "questions": []
}

Rules (strict):
- Prefer ready=true. Use RECENT CHAT HISTORY to fill list names, stages (Hot/Engage/Cold/Prospect), campaigns, and apps. Do NOT re-ask for facts already stated in history.
- In Attio, Hot / Engage / Cold / Prospect / Sent / Open / Click are usually LIST STAGES (status), not mystery attributes. If the user asks what is in Hot, goal = query that stage on the list from history (often "HR campaign").
- ready=false ONLY when history is empty AND a blocking fact is missing (which app with no connection, which list when never named). Max 1 short question. Prefer [].
- If history already names an Attio list / campaign / stage mapping, ready MUST be true and questions MUST be [].
- Do not ask for API keys if the app is connected.
- Never invent tool results. Never include markdown outside JSON.`;

  const user = `Project: ${input.projectName || "unknown"}
Connected apps: ${input.connected.length ? input.connected.join(", ") : "none"}
Attached files: ${(input.fileNames || []).join(", ") || "none"}

Recent chat history:
${history || "(none — first messages)"}

Latest user message:
${original}`;

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  try {
    const reply = await complete(messages, []);
    const parsed = extractJsonObject(String(reply.content || ""));
    if (!parsed) return fallbackReady(original);

    const goal = String(parsed.goal || "").trim();
    const apps = asStringArray(parsed.apps);
    const data = String(parsed.data || "").trim();
    const output = String(parsed.output || "").trim();
    const constraints = String(parsed.constraints || "").trim();
    let questions = asStringArray(parsed.questions).slice(0, 1);

    // Never block an active conversation for clarifying questions.
    if (hasHistory) questions = [];

    const ready = questions.length === 0 || parsed.ready !== false;
    if (ready) questions = [];

    return {
      ready: true,
      goal,
      apps,
      data,
      output,
      constraints,
      questions: [],
      brief: buildBrief({ goal, apps, data, output, constraints, original }),
    };
  } catch {
    return fallbackReady(original);
  }
}

export function formatClarifyingQuestions(questions: string[], goal?: string) {
  const intro = goal
    ? `I want to make sure I do this right.\n\n**I understand:** ${goal}\n\nQuick questions before I start:`
    : "Quick questions before I start:";
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `${intro}\n${list}`;
}
