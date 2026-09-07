import {
  BREVO_MCP_CAMPAIGNS,
  BREVO_MCP_DEFAULT,
} from "@/lib/integration-constants";

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

async function withMcpSession<T>(
  mcpUrl: string,
  apiKey: string,
  run: (sessionId: string) => Promise<T>,
) {
  const init = await mcpRequest(mcpUrl, apiKey, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nexuses", version: "1.0.0" },
  });
  try {
    await mcpRequest(mcpUrl, apiKey, "notifications/initialized", undefined, init.sessionId);
  } catch {
    // Some servers ignore the follow-up notification.
  }
  return run(init.sessionId);
}

export async function validateBrevoMcp(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  await withMcpSession(url, apiKey, async () => ({ ok: true as const }));
  return { ok: true as const, mcpUrl: url };
}

export async function listBrevoMcpTools(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  return withMcpSession(url, apiKey, async (sessionId) => {
    const listed = await mcpRequest(url, apiKey, "tools/list", {}, sessionId);
    const tools = ((listed.data as { tools?: McpTool[] } | undefined)?.tools || []) as McpTool[];
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema || {},
    }));
  });
}

export function filterBrevoMcpTools(
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>,
  query?: string,
) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return tools;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tools.filter((tool) => {
    const hay = `${tool.name} ${tool.description}`.toLowerCase();
    return tokens.every((token) => hay.includes(token));
  });
}

export function resolveBrevoMcpToolName(
  tools: Array<{ name: string }>,
  requested: string,
): { exact?: string; suggestions: string[] } {
  const want = requested.trim();
  if (!want) return { suggestions: [] };
  const lower = want.toLowerCase();
  const exact = tools.find((tool) => tool.name === want || tool.name.toLowerCase() === lower);
  if (exact) return { exact: exact.name, suggestions: [] };

  const suggestions = tools
    .map((tool) => tool.name)
    .filter((name) => {
      const n = name.toLowerCase();
      return n.includes(lower) || lower.includes(n) || n.replace(/_/g, "").includes(lower.replace(/_/g, ""));
    })
    .slice(0, 12);

  // Prefer common campaign list naming.
  if (!suggestions.length && /campaign/i.test(want)) {
    return {
      suggestions: tools
        .map((t) => t.name)
        .filter((n) => /campaign/i.test(n) && /(get|list|search)/i.test(n))
        .slice(0, 12),
    };
  }
  return { suggestions };
}

export async function callBrevoMcpTool(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
  mcpUrl = BREVO_MCP_DEFAULT,
) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  return withMcpSession(url, apiKey, async (sessionId) => {
    const result = await mcpRequest(
      url,
      apiKey,
      "tools/call",
      { name: toolName, arguments: args },
      sessionId,
    );
    return clip(result.data ?? { ok: true }, 14000);
  });
}

/** List email campaigns via focused campaign MCP (avoids 280-tool mega-server). */
export async function listBrevoCampaignsViaMcp(
  apiKey: string,
  options: {
    status?: string;
    limit?: number;
    offset?: number;
    type?: string;
  } = {},
) {
  const status = String(options.status || "").trim() || undefined;
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const type = String(options.type || "").trim() || undefined;

  const args: Record<string, unknown> = { limit, offset };
  if (status) args.status = status;
  if (type) args.type = type;

  const urls = [BREVO_MCP_CAMPAIGNS, BREVO_MCP_DEFAULT];
  const candidates = ["get_email_campaigns", "list_email_campaigns", "getEmailCampaigns"];

  let lastError = "";
  for (const url of urls) {
    let tools: Array<{ name: string; description: string }> = [];
    try {
      tools = await listBrevoMcpTools(apiKey, url);
    } catch (err) {
      lastError = err instanceof Error ? err.message : "tools/list failed";
      continue;
    }

    const resolved =
      candidates
        .map((name) => resolveBrevoMcpToolName(tools, name).exact)
        .find(Boolean) ||
      resolveBrevoMcpToolName(tools, "get_email_campaigns").suggestions[0] ||
      tools.find((t) => /get_email_campaigns/i.test(t.name))?.name ||
      tools.find((t) => /email.?campaign/i.test(t.name) && /(get|list)/i.test(t.name))?.name;

    if (!resolved) {
      lastError = `No campaign list tool on ${url}. Found: ${tools
        .map((t) => t.name)
        .filter((n) => /campaign/i.test(n))
        .slice(0, 20)
        .join(", ") || "none"}`;
      continue;
    }

    try {
      const raw = await callBrevoMcpTool(apiKey, resolved, args, url);
      return {
        ok: true as const,
        tool: resolved,
        mcpUrl: url,
        status: status || "any",
        data: raw,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "tools/call failed";
    }
  }

  throw new Error(lastError || "Could not list Brevo campaigns via MCP");
}
