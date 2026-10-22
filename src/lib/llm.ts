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

type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
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

function claudeApiKey() {
  return String(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
}

function claudeModel(vision: boolean) {
  return (
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_MODEL ||
    (vision ? process.env.ANTHROPIC_VISION_MODEL : "") ||
    "claude-sonnet-4-5"
  );
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
  const claude = claudeApiKey();
  const grok = grokApiKey();
  if (claude && grok) return `claude (${claudeModel(false)}), fallback grok`;
  if (claude) return `claude (${claudeModel(false)})`;
  const { provider, model } = config(false);
  return `${provider} (${model})`;
}

function tokenCap(tools: ToolDef[]) {
  const raw = tools.length
    ? Number(process.env.LLM_MAX_TOKENS_TOOLS || 8192)
    : Number(process.env.LLM_MAX_TOKENS_REPLY || 2048);
  return Number.isFinite(raw) && raw > 0 ? raw : tools.length ? 8192 : 2048;
}

function anthropicImage(url: string) {
  const data = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (data) {
    return {
      type: "image",
      source: { type: "base64", media_type: data[1], data: data[2] },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function toAnthropic(messages: LlmMessage[]) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

  const out: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];
  const push = (role: "user" | "assistant", content: string | unknown[]) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role && typeof prev.content === "string" && typeof content === "string") {
      prev.content = `${prev.content}\n\n${content}`;
      return;
    }
    if (
      prev &&
      prev.role === role &&
      role === "user" &&
      Array.isArray(prev.content) &&
      Array.isArray(content)
    ) {
      prev.content.push(...content);
      return;
    }
    out.push({ role, content });
  };

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      push("user", [
        { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content },
      ]);
      continue;
    }
    if (message.role === "assistant" && "tool_calls" in message && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        let input: Record<string, unknown> = {};
        const raw = call.function.arguments;
        if (typeof raw === "string") {
          try {
            input = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            input = {};
          }
        } else if (raw && typeof raw === "object") {
          input = raw;
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      push("assistant", blocks);
      continue;
    }
    if (message.role === "assistant") {
      push("assistant", message.content || "");
      continue;
    }
    if (typeof message.content === "string") {
      push("user", message.content);
      continue;
    }
    push(
      "user",
      message.content.map((part) =>
        part.type === "text" ? { type: "text", text: part.text } : anthropicImage(part.image_url.url),
      ),
    );
  }

  if (!out.length) push("user", "Continue.");
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "Continue." });
  return { system, messages: out };
}

async function completeClaude(
  messages: LlmMessage[],
  tools: ToolDef[],
  vision: boolean,
): Promise<AssistantMessage> {
  const key = claudeApiKey();
  const converted = toAnthropic(messages);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: claudeModel(vision),
      max_tokens: tokenCap(tools),
      temperature: tools.length ? 0.2 : 0.5,
      system: converted.system || undefined,
      messages: converted.messages,
      tools: tools.length
        ? tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters,
          }))
        : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 400);
    throw new Error(detail || `Claude error ${res.status}`);
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((block: { type?: string; text?: string }) => block.type === "text" && block.text)
    .map((block: { text: string }) => block.text)
    .join("\n")
    .trim();
  const tool_calls = blocks
    .filter((block: { type?: string }) => block.type === "tool_use")
    .map((block: { id: string; name: string; input?: Record<string, unknown> }) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
    }));
  if (!text && !tool_calls.length) throw new Error("Empty Claude response");
  return { role: "assistant", content: text || null, tool_calls: tool_calls.length ? tool_calls : undefined };
}

async function completeCompatible(
  messages: LlmMessage[],
  tools: ToolDef[],
  options: CompleteOptions | undefined,
  runtime: LlmRuntimeConfig,
): Promise<AssistantMessage> {
  const { provider, url, key, model } = runtime;

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
      temperature: tools.length ? 0.2 : 0.5,
      max_tokens: tools.length
        ? Number(process.env.LLM_MAX_TOKENS_TOOLS || 8192)
        : Number(process.env.LLM_MAX_TOKENS_REPLY || 2048),
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
  return choice as AssistantMessage;
}

export async function complete(
  messages: LlmMessage[],
  tools: ToolDef[],
  options?: CompleteOptions,
) {
  const vision = messageHasImages(messages);
  if (claudeApiKey()) {
    try {
      return await completeClaude(messages, tools, vision);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!grokApiKey()) throw new Error(message);
      console.error(`Claude failed, falling back to Grok: ${message}`);
    }
  }
  return completeCompatible(messages, tools, options, config(vision));
}

export type { LlmMessage };
