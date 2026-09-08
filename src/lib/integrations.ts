import { Integration } from "@/models/Integration";
import { serializeIntegration, maskKey } from "@/lib/serialize-integration";
import type { AuthType, IntegrationDTO, Provider } from "@/types/chat";
import { findKnownCustomApi } from "@/lib/known-custom-apis";

export type StoredIntegrationInput = {
  userId: string;
  projectId: string;
  provider: Provider;
  name: string;
  apiKey: string;
  restApiKey?: string;
  baseUrl?: string;
  mcpUrl?: string;
  authType?: AuthType;
  /** When true, keep existing apiKey/mcpUrl and only set restApiKey. */
  restOnly?: boolean;
};

const PROVIDERS = new Set<Provider>(["attio", "brevo", "lemlist", "notion", "other"]);

export function normalizeProvider(raw: string): Provider {
  const value = raw.trim().toLowerCase();
  if (value === "attio") return "attio";
  if (value === "brevo" || value === "sendinblue") return "brevo";
  if (value === "lemlist" || value === "lem list") return "lemlist";
  if (value === "notion") return "notion";
  if (value === "other" || value === "custom" || value === "api") return "other";
  throw new Error('Provider must be "attio", "brevo", "lemlist", "notion", or "other"');
}

export function displayProviderName(provider: Provider, name?: string) {
  if (provider === "other") return name?.trim() || "Custom API";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function parseAuthType(raw: unknown): AuthType {
  if (raw === "api-key" || raw === "basic" || raw === "query" || raw === "authorization") {
    return raw;
  }
  return "bearer";
}

/** SmartLead (and similar) expect ?api_key= on the URL, not Bearer headers. */
export function looksLikeQueryApiKeyAuth(input: {
  name?: string;
  baseUrl?: string;
  authType?: AuthType;
}) {
  if (input.authType === "query") return true;
  const known = findKnownCustomApi(`${input.name || ""} ${input.baseUrl || ""}`);
  return known?.authType === "query";
}

/** MailBluster uses Authorization: <raw key> (no Bearer prefix). */
export function looksLikeRawAuthorizationAuth(input: {
  name?: string;
  baseUrl?: string;
  authType?: AuthType;
}) {
  if (input.authType === "authorization") return true;
  const known = findKnownCustomApi(`${input.name || ""} ${input.baseUrl || ""}`);
  return known?.authType === "authorization";
}

export function normalizeCustomBaseUrl(name: string, baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed) return trimmed;
  const known = findKnownCustomApi(name);
  return known?.baseUrl || "";
}

export function resolveCustomAuthType(input: {
  name: string;
  baseUrl?: string;
  authType?: AuthType;
}): AuthType {
  const known = findKnownCustomApi(`${input.name} ${input.baseUrl || ""}`);
  if (known) return known.authType;
  return input.authType || "bearer";
}

export function normalizeMcpUrl(raw: string) {
  const value = raw.trim().replace(/\/$/, "");
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("MCP URL must start with https://");
    }
    return url.toString().replace(/\/$/, "");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("MCP URL")) throw err;
    throw new Error("MCP URL must be a valid URL, e.g. https://mcp.brevo.com/v1/brevo/mcp");
  }
}

/** Strip Bearer / api-key prefixes and invisible chars people paste from Brevo configs. */
export function normalizeBrevoApiKey(raw: string) {
  let key = String(raw || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  key = key.replace(/^\s*authorization\s*:\s*/i, "").trim();
  key = key.replace(/^bearer\s+/i, "").trim();
  key = key.replace(/^\s*api[_-]?key\s*[:=]\s*/i, "").trim();
  return key;
}

export function isLikelyApiAuthRejection(message: string) {
  const text = message || "";
  if (/\b401\b/.test(text)) return true;
  if (/unauthorized/i.test(text) && !/cloudflare|<!doctype|html>/i.test(text)) return true;
  // Do not treat generic 403/proxy/WAF pages as an invalid API key.
  return false;
}

export { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";

export async function upsertIntegrationDoc(
  input: StoredIntegrationInput,
): Promise<IntegrationDTO & { apiKey: string; restApiKey: string }> {
  if (!PROVIDERS.has(input.provider)) {
    throw new Error("Choose Attio, Brevo, Lemlist, Notion, or Other");
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("API key is required");
  if (input.provider === "other" && input.name.trim().length < 2) {
    throw new Error("Give this custom API a name");
  }

  const query =
    input.provider === "other"
      ? {
          userId: input.userId,
          projectId: input.projectId,
          provider: input.provider,
          name: input.name.trim(),
        }
      : { userId: input.userId, projectId: input.projectId, provider: input.provider };

  const doc = await Integration.findOneAndUpdate(
    query,
    input.restOnly
      ? {
          $set: {
            restApiKey: apiKey,
            name: input.name.trim(),
          },
        }
      : {
          userId: input.userId,
          projectId: input.projectId,
          provider: input.provider,
          name: input.name.trim(),
          apiKey,
          restApiKey: (input.restApiKey || "").trim(),
          baseUrl: (input.baseUrl || "").trim().replace(/\/$/, ""),
          mcpUrl: (input.mcpUrl || "").trim().replace(/\/$/, ""),
          authType: input.authType ?? "bearer",
        },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ...serializeIntegration(doc), apiKey: doc.apiKey, restApiKey: doc.restApiKey || "" };
}

export async function removeIntegrationDoc(input: {
  userId: string;
  projectId: string;
  provider?: Provider;
  name?: string;
  id?: string;
}) {
  const filter: Record<string, unknown> = {
    userId: input.userId,
    projectId: input.projectId,
  };
  if (input.id) {
    filter._id = input.id;
  } else if (input.provider === "other" && input.name) {
    filter.provider = "other";
    filter.name = input.name;
  } else if (input.provider && input.provider !== "other") {
    filter.provider = input.provider;
  } else if (input.name) {
    filter.name = new RegExp(`^${input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  } else {
    throw new Error(
      "Say which integration to disconnect (Attio, Brevo, Lemlist, Notion, or the custom name)",
    );
  }

  const doc = await Integration.findOneAndDelete(filter);
  if (!doc) throw new Error("That integration was not connected");
  return serializeIntegration(doc);
}

export function redactSecrets(text: string, secrets: string[]) {
  let out = text;
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < 8) continue;
    out = out.split(value).join(maskKey(value));
  }
  return out;
}

export { maskKey };
