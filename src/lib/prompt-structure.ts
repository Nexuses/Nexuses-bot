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
  return /^(yes|yeah|yep|ok|okay|sure|go ahead|do it|proceed|continue|no,?\s|use |brevo|lemlist|attio|notion|last week|this week)/i.test(
    text.trim(),
  );
}

export function needsPromptStructuring(input: {
  text: string;
  fileCount: number;
  lastAssistantText?: string;
}) {
  const text = input.text.trim();
  if (!text && input.fileCount === 0) return false;

  // User is answering our clarifying questions — don't ask again; execute.
  if (
    input.lastAssistantText &&
    /clarif|quick question|before i (can )?(start|continue|build|pull)|need (a bit )?more|which (one|tool|app|campaign)/i.test(
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

/**
 * Rewrite messy user asks into a clear brief. If critical info is missing,
 * return ready=false with up to 2 clarifying questions.
 */
export async function structureUserPrompt(input: {
  text: string;
  connected: string[];
  fileNames?: string[];
  projectName?: string;
}): Promise<StructuredPrompt> {
  const original = input.text.trim() || "(files attached; infer task from files + history)";
  const system = `You clarify user requests for Nexuses, an action agent that uses tools (Attio, Brevo, Lemlist, Notion, custom APIs, HTML dashboards).

Return ONLY compact JSON:
{
  "ready": boolean,
  "goal": "one sentence",
  "apps": ["brevo"],
  "data": "what data to use or fetch",
  "output": "what to deliver (table, dashboard link, import, etc.)",
  "constraints": "dates, brands, real numbers only, etc.",
  "questions": ["optional clarifying question"]
}

Rules:
- ready=true when you can execute without guessing critical missing facts.
- ready=false only when a blocking ambiguity remains (which app, which campaign, date range, output type). Max 2 short questions.
- Do not ask for API keys if the needed app is already in connected.
- Prefer ready=true for clear action asks even if some details are defaultable (e.g. last 7 days).
- Never invent tool results. Never include markdown outside JSON.`;

  const user = `Project: ${input.projectName || "unknown"}
Connected apps: ${input.connected.length ? input.connected.join(", ") : "none"}
Attached files: ${(input.fileNames || []).join(", ") || "none"}

User message:
${original}`;

  const messages: LlmMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  try {
    const reply = await complete(messages, []);
    const parsed = extractJsonObject(String(reply.content || ""));
    if (!parsed) {
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

    const goal = String(parsed.goal || "").trim();
    const apps = asStringArray(parsed.apps);
    const data = String(parsed.data || "").trim();
    const output = String(parsed.output || "").trim();
    const constraints = String(parsed.constraints || "").trim();
    const questions = asStringArray(parsed.questions).slice(0, 2);
    const ready = parsed.ready !== false && questions.length === 0;

    return {
      ready,
      goal,
      apps,
      data,
      output,
      constraints,
      questions: ready ? [] : questions,
      brief: buildBrief({ goal, apps, data, output, constraints, original }),
    };
  } catch {
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
}

export function formatClarifyingQuestions(questions: string[], goal?: string) {
  const intro = goal
    ? `I want to make sure I do this right.\n\n**I understand:** ${goal}\n\nQuick questions before I start:`
    : "Quick questions before I start:";
  const list = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return `${intro}\n${list}`;
}
