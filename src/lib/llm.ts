export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

type LlmMessage =
  | { role: "system" | "assistant"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string | Record<string, unknown> };
};

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type CompleteOptions = {
  /** xAI: routes follow-up requests for prompt caching (use chat id). */
  conversationId?: string;
};

type LlmRuntimeConfig = {
  provider: "grok" | "deepseek" | "openai";
  url: string;
  key: string;
  model: string;
};

function messageHasImages(messages: LlmMessage[]) {
  return messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
}

function grokApiKey() {
  return String(process.env.XAI_API_KEY || process.env.GROK_API_KEY || "").trim();
}

function grokChatCompletionsUrl() {
  const base = String(
    process.env.XAI_API_BASE || process.env.GROK_API_BASE || "https://api.x.ai/v1",
  )
    .trim()
    .replace(/\/$/, "");
  return `${base}/chat/completions`;
}

function resolveProvider(): "grok" | "deepseek" | "openai" {
  const raw = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (raw === "grok" || raw === "xai") return "grok";
  if (raw === "deepseek") return "deepseek";
  if (raw === "openai") return "openai";

  if (grokApiKey()) return "grok";
  if (String(process.env.DEEPSEEK_API_KEY || "").trim()) return "deepseek";
  if (String(process.env.OPENAI_API_KEY || "").trim()) return "openai";

  throw new Error(
    "No LLM configured. Add XAI_API_KEY or GROK_API_KEY (Grok) to .env.local — see https://console.x.ai",
  );
}

function config(vision = false): LlmRuntimeConfig {
  const provider = resolveProvider();
  const grok = grokApiKey();
  const deepseek = String(process.env.DEEPSEEK_API_KEY || "").trim();
  const openai = String(process.env.OPENAI_API_KEY || "").trim();

  if (provider === "grok") {
    if (!grok) {
      throw new Error(
        "LLM_PROVIDER=grok but XAI_API_KEY / GROK_API_KEY is missing. Create a key at https://console.x.ai and restart the dev server.",
      );
    }
    return {
      provider: "grok",
      url: grokChatCompletionsUrl(),
      key: grok,
      model:
        process.env.GROK_MODEL ||
        process.env.XAI_MODEL ||
        (vision
          ? process.env.GROK_VISION_MODEL || "grok-4.6"
          : "grok-4.6"),
    };
  }

  if (provider === "deepseek") {
    if (!deepseek) {
      throw new Error(
        "LLM_PROVIDER=deepseek but DEEPSEEK_API_KEY is missing. Set the key or switch LLM_PROVIDER=grok with XAI_API_KEY.",
      );
    }
    return {
      provider: "deepseek",
      url: "https://api.deepseek.com/chat/completions",
      key: deepseek,
      model: vision
        ? process.env.DEEPSEEK_VISION_MODEL || "deepseek-v4-flash-vision-exp"
        : process.env.DEEPSEEK_MODEL || "deepseek-chat",
    };
  }

  if (!openai) {
    throw new Error(
      "LLM_PROVIDER=openai but OPENAI_API_KEY is missing. Set the key or use Grok (LLM_PROVIDER=grok + XAI_API_KEY).",
    );
  }
  return {
    provider: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    key: openai,
    model: vision
      ? process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
      : process.env.OPENAI_MODEL || "gpt-4o-mini",
  };
}

/** Which model provider is active (for logs / health). */
export function activeLlmDescription() {
  const { provider, model } = config(false);
  return `${provider} (${model})`;
}

export async function complete(
  messages: LlmMessage[],
  tools: ToolDef[],
  options?: CompleteOptions,
) {
  const vision = messageHasImages(messages);
  const { provider, url, key, model } = config(vision);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  const convId = String(options?.conversationId || "").trim();
  if (provider === "grok" && convId) {
    headers["x-grok-conv-id"] = convId.slice(0, 128);
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? "auto" : undefined,
      temperature: tools.length ? 0.2 : 0.6,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 400);
    const hint =
      provider === "grok" && /model|not found|invalid/i.test(String(detail))
        ? ` (try GROK_MODEL=grok-4.6 in .env.local)`
        : "";
    throw new Error((detail || `LLM error ${res.status}`) + hint);
  }

  const choice = data.choices?.[0]?.message;
  if (!choice) throw new Error("Empty LLM response");
  return choice as {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
}

export type { LlmMessage };
