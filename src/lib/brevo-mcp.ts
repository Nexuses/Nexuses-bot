import { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";

type JsonRpcResult = {
  result?: unknown;
  error?: { message?: string; code?: number };
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

function clip(data: unknown, max = 14000) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n…truncated` : text;
}

async function mcpRequest(
  mcpUrl: string,
  apiKey: string,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      ...(params ? { params } : {}),
    }),
    cache: "no-store",
  });

  const nextSession = res.headers.get("mcp-session-id") || sessionId || "";
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  }

  // Some MCP HTTP transports return SSE frames.
  const jsonLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data: "));
  const payload = jsonLine ? jsonLine.slice(6) : text;
  let parsed: JsonRpcResult;
  try {
    parsed = JSON.parse(payload) as JsonRpcResult;
  } catch {
    throw new Error(`Brevo MCP returned a non-JSON response: ${text.slice(0, 400)}`);
  }
  if (parsed.error) {
    throw new Error(parsed.error.message || `Brevo MCP error ${parsed.error.code ?? ""}`.trim());
  }
  return { data: parsed.result, sessionId: nextSession };
}

export async function validateBrevoMcp(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  const init = await mcpRequest(url, apiKey, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nexuses", version: "1.0.0" },
  });
  try {
    await mcpRequest(url, apiKey, "notifications/initialized", undefined, init.sessionId);
  } catch {
    // Some servers ignore the follow-up notification.
  }
  return { ok: true as const, mcpUrl: url };
}

export async function listBrevoMcpTools(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  const init = await mcpRequest(url, apiKey, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nexuses", version: "1.0.0" },
  });
  try {
    await mcpRequest(url, apiKey, "notifications/initialized", undefined, init.sessionId);
  } catch {
    // ignore
  }
  const listed = await mcpRequest(url, apiKey, "tools/list", {}, init.sessionId);
  const tools = ((listed.data as { tools?: McpTool[] } | undefined)?.tools || []) as McpTool[];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema || {},
  }));
}

export async function callBrevoMcpTool(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
  mcpUrl = BREVO_MCP_DEFAULT,
) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  const init = await mcpRequest(url, apiKey, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nexuses", version: "1.0.0" },
  });
  try {
    await mcpRequest(url, apiKey, "notifications/initialized", undefined, init.sessionId);
  } catch {
    // ignore
  }
  const result = await mcpRequest(
    url,
    apiKey,
    "tools/call",
    { name: toolName, arguments: args },
    init.sessionId,
  );
  return clip(result.data ?? { ok: true }, 14000);
}
