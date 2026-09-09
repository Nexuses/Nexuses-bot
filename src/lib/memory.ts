import MemoryClient from "mem0ai";

const AGENT_ID = "nexuses";
const SEARCH_TIMEOUT_MS = 2500;
const MAX_MEMORY_CHARS = 2500;

function mem0Enabled() {
  return Boolean(process.env.MEM0_API_KEY?.trim());
}

function getClient() {
  const apiKey = process.env.MEM0_API_KEY?.trim();
  if (!apiKey) return null;
  return new MemoryClient({
    apiKey,
    host: process.env.MEM0_HOST?.trim() || undefined,
  });
}

function clipMemories(lines: string[]) {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = line.trim();
    if (!next) continue;
    if (used + next.length + 1 > MAX_MEMORY_CHARS) break;
    out.push(next);
    used += next.length + 1;
  }
  return out;
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    task
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

export async function searchMemories(input: {
  userId: string;
  projectId: string;
  chatId?: string;
  query: string;
}) {
  if (!mem0Enabled()) return [];
  const client = getClient();
  if (!client) return [];
  const query = input.query.trim().slice(0, 500);
  if (!query) return [];

  const result = await withTimeout(
    client.search(query, {
      filters: {
        userId: input.userId,
        agentId: AGENT_ID,
      },
      topK: 8,
      threshold: 0.2,
    }),
    SEARCH_TIMEOUT_MS,
  );

  const rows = result?.results || [];
  return clipMemories(
    rows
      .map((row) => String(row.memory || row.data?.memory || "").trim())
      .filter(Boolean),
  );
}

export function formatMemoryPrompt(memories: string[]) {
  if (!memories.length) return "";
  return `Long-term memory about this user (use when relevant; do not invent beyond this):\n${memories
    .map((item) => `- ${item}`)
    .join("\n")}`;
}

/** Fire-and-forget: extract lasting facts from this turn into Mem0. */
export function rememberChatTurn(input: {
  userId: string;
  projectId: string;
  chatId: string;
  userText: string;
  assistantText: string;
}) {
  if (!mem0Enabled()) return;
  const userText = input.userText.trim().slice(0, 4000);
  const assistantText = input.assistantText.trim().slice(0, 6000);
  if (!userText || !assistantText) return;

  const client = getClient();
  if (!client) return;

  void client
    .add(
      [
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ],
      {
        userId: input.userId,
        agentId: AGENT_ID,
        runId: input.chatId,
        metadata: { projectId: input.projectId },
        infer: true,
      },
    )
    .catch(() => {
      // Memory must never break chat replies.
    });
}

export function isMem0Configured() {
  return mem0Enabled();
}
