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

function messageHasImages(messages: LlmMessage[]) {
  return messages.some(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image_url"),
  );
}

function config(vision = false) {
  const deepseek = process.env.DEEPSEEK_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  const provider =
    process.env.LLM_PROVIDER || (deepseek ? "deepseek" : openai ? "openai" : "");

  if (provider === "deepseek" && deepseek) {
    return {
      url: "https://api.deepseek.com/chat/completions",
      key: deepseek,
      model: vision
        ? process.env.DEEPSEEK_VISION_MODEL || "deepseek-v4-flash-vision-exp"
        : process.env.DEEPSEEK_MODEL || "deepseek-chat",
    };
  }

  if (openai) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      key: openai,
      model: vision
        ? process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
        : process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  throw new Error("Set DEEPSEEK_API_KEY or OPENAI_API_KEY in .env.local");
}

export async function complete(messages: LlmMessage[], tools: ToolDef[]) {
  const vision = messageHasImages(messages);
  const { url, key, model } = config(vision);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
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
    throw new Error(detail || `LLM error ${res.status}`);
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
