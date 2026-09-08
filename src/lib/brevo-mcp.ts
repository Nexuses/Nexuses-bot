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
  options?: { authHeader?: "bearer" | "api-key" },
) {
  const authHeader = options?.authHeader || "bearer";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (authHeader === "api-key") {
    headers["api-key"] = apiKey;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
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
  run: (sessionId: string, authHeader: "bearer" | "api-key") => Promise<T>,
) {
  const modes: Array<"bearer" | "api-key"> = ["bearer", "api-key"];
  let lastError: unknown;

  for (const authHeader of modes) {
    try {
      const init = await mcpRequest(
        mcpUrl,
        apiKey,
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "nexuses", version: "1.0.0" },
        },
        undefined,
        { authHeader },
      );
      try {
        await mcpRequest(
          mcpUrl,
          apiKey,
          "notifications/initialized",
          undefined,
          init.sessionId,
          { authHeader },
        );
      } catch {
        // Some servers ignore the follow-up notification.
      }
      return await run(init.sessionId, authHeader);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const authFail = /\b401\b|unauthorized|invalid.*key|authentication/i.test(message);
      if (!authFail) throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Brevo MCP auth failed"));
}

export async function validateBrevoMcp(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  const key = apiKey.trim();
  if (!key) throw new Error("Brevo API key is required");
  await withMcpSession(url, key, async () => ({ ok: true as const }));
  return { ok: true as const, mcpUrl: url };
}

export async function listBrevoMcpTools(apiKey: string, mcpUrl = BREVO_MCP_DEFAULT) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  return withMcpSession(url, apiKey, async (sessionId, authHeader) => {
    const listed = await mcpRequest(url, apiKey, "tools/list", {}, sessionId, { authHeader });
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
  const raw = await callBrevoMcpToolRaw(apiKey, toolName, args, mcpUrl);
  return clip(raw ?? { ok: true }, 14000);
}

export async function callBrevoMcpToolRaw(
  apiKey: string,
  toolName: string,
  args: Record<string, unknown> = {},
  mcpUrl = BREVO_MCP_DEFAULT,
) {
  const url = mcpUrl || BREVO_MCP_DEFAULT;
  return withMcpSession(url, apiKey, async (sessionId, authHeader) => {
    const result = await mcpRequest(
      url,
      apiKey,
      "tools/call",
      { name: toolName, arguments: args },
      sessionId,
      { authHeader },
    );
    return result.data ?? null;
  });
}

const HTML_KEYS = new Set([
  "htmlcontent",
  "html",
  "htmlurl",
  "previewtext",
  "mirroractive",
]);

function asCampaignObjects(data: unknown): Record<string, unknown>[] {
  if (!data) return [];
  if (typeof data === "string") {
    try {
      return asCampaignObjects(JSON.parse(data));
    } catch {
      // MCP often wraps JSON in text content.
      const match = data.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (match) {
        try {
          return asCampaignObjects(JSON.parse(match[0]));
        } catch {
          return [];
        }
      }
      return [];
    }
  }
  if (Array.isArray(data)) {
    return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  }
  if (typeof data === "object") {
    const record = data as Record<string, unknown>;
    // MCP tools/call shape: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(record.content)) {
      const texts = record.content
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text || "")
            : "",
        )
        .filter(Boolean);
      if (texts.length) return asCampaignObjects(texts.join("\n"));
    }
    for (const key of ["campaigns", "data", "result", "items", "emailCampaigns"]) {
      if (record[key] != null) {
        const nested = asCampaignObjects(record[key]);
        if (nested.length) return nested;
      }
    }
    if ("name" in record || "id" in record || "status" in record) return [record];
  }
  return [];
}

function pickStats(campaign: Record<string, unknown>) {
  const stats =
    (campaign.statistics as Record<string, unknown> | undefined) ||
    (campaign.globalStats as Record<string, unknown> | undefined) ||
    {};
  const global =
    (stats.globalStats as Record<string, unknown> | undefined) ||
    (stats.globalStatistics as Record<string, unknown> | undefined) ||
    stats;
  return {
    sent: global.sent ?? global.delivered ?? undefined,
    delivered: global.delivered ?? undefined,
    uniqueOpens: global.uniqueOpens ?? global.viewed ?? undefined,
    uniqueClicks: global.uniqueClicks ?? global.clickers ?? undefined,
    unsubscriptions: global.unsubscriptions ?? undefined,
    softBounces: global.softBounces ?? undefined,
    hardBounces: global.hardBounces ?? undefined,
  };
}

/** Compact campaign rows for the LLM — never include HTML bodies. */
export function summarizeBrevoCampaigns(data: unknown, options?: { limit?: number }) {
  const limit = Math.min(Math.max(Number(options?.limit) || 50, 1), 100);
  const campaigns = asCampaignObjects(data).slice(0, limit).map((campaign) => {
    const sender =
      campaign.sender && typeof campaign.sender === "object"
        ? (campaign.sender as Record<string, unknown>)
        : {};
    return {
      id: campaign.id ?? campaign.campaignId ?? undefined,
      name: campaign.name ?? campaign.campaignName ?? "",
      subject: campaign.subject ?? "",
      status: campaign.status ?? "",
      type: campaign.type ?? "",
      scheduledAt: campaign.scheduledAt ?? "",
      sentDate: campaign.sentDate ?? campaign.sentAt ?? "",
      createdAt: campaign.createdAt ?? "",
      modifiedAt: campaign.modifiedAt ?? "",
      sender: {
        name: sender.name ?? "",
        email: sender.email ?? "",
      },
      stats: pickStats(campaign),
    };
  });

  return {
    count: campaigns.length,
    campaigns,
    note: "HTML bodies were removed. This is a compact partial/summary list suitable for tables.",
  };
}

function stripHtmlFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHtmlFields);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (HTML_KEYS.has(key.toLowerCase())) continue;
    if (typeof nested === "string" && nested.length > 500 && /<\s*html|<\s*body|<\s*div/i.test(nested)) {
      continue;
    }
    out[key] = stripHtmlFields(nested);
  }
  return out;
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

  // Ask Brevo to omit HTML when supported; we also strip it ourselves.
  const args: Record<string, unknown> = {
    limit,
    offset,
    excludeHtmlContent: true,
    exclude_html_content: true,
  };
  if (status) args.status = status;
  if (type) args.type = type;

  const urls = [BREVO_MCP_CAMPAIGNS, BREVO_MCP_DEFAULT];
  const candidates = [
    "get_email_campaigns",
    "list_email_campaigns",
    "getEmailCampaigns",
    "email_campaign_management_get_email_campaigns",
  ];

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
      tools.find((t) => /get_email_campaigns$/i.test(t.name))?.name ||
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
      // Fetch in small pages so HTML (if still present) cannot wipe the whole list.
      const pageSize = Math.min(limit, 5);
      const collected: Record<string, unknown>[] = [];
      for (let pageOffset = offset; collected.length < limit; pageOffset += pageSize) {
        const pageArgs = { ...args, limit: pageSize, offset: pageOffset };
        const raw = await callBrevoMcpToolRaw(apiKey, resolved, pageArgs, url);
        const stripped = stripHtmlFields(raw);
        const page = summarizeBrevoCampaigns(stripped, { limit: pageSize }).campaigns;
        if (!page.length) break;
        collected.push(...page);
        if (page.length < pageSize) break;
      }

      return {
        ok: true as const,
        tool: resolved,
        mcpUrl: url,
        status: status || "any",
        ...summarizeBrevoCampaigns(collected, { limit }),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "tools/call failed";
    }
  }

  throw new Error(lastError || "Could not list Brevo campaigns via MCP");
}
