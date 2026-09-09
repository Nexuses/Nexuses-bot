import { BREVO_MCP_DEFAULT } from "@/lib/integration-constants";
import { validateBrevoMcp } from "@/lib/brevo-mcp";
import {
  brevoKeyHint,
  isBrevoIpAuthorizationError,
  normalizeBrevoApiKey,
} from "@/lib/integrations";

const BREVO_REST = "https://api.brevo.com";
const BREVO_REST_LEGACY = "https://api.sendinblue.com";

export type BrevoConnectResult = {
  mcpUrl: string;
  verified: boolean;
  warning?: string;
};

function brevoRestHeaders(apiKey: string) {
  return {
    "api-key": apiKey,
    accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function probeRestAccount(apiKey: string, host: string) {
  const res = await fetch(`${host}/v3/account`, {
    headers: brevoRestHeaders(apiKey),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return true;
}

async function outboundIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    if (!res.ok) return "";
    const data = (await res.json()) as { ip?: string };
    return String(data.ip || "").trim();
  } catch {
    return "";
  }
}

function looksLikeRestKey(apiKey: string) {
  return /^xkeysib-/i.test(apiKey);
}

function looksLikeSmtpKey(apiKey: string) {
  return /^xsmtpsib-/i.test(apiKey);
}

/**
 * Resolve how to store a Brevo key.
 * Prefers live verification, but will still save a well-formed key if Brevo
 * returns 401 (common with IP allowlists / MCP-only tokens) so connect is not blocked.
 */
export async function resolveBrevoConnection(rawKey: string): Promise<BrevoConnectResult> {
  const apiKey = normalizeBrevoApiKey(rawKey);
  if (!apiKey) throw new Error("Brevo API key is required");
  if (looksLikeSmtpKey(apiKey)) {
    throw new Error(
      "That looks like a Brevo SMTP key (xsmtpsib-…), not an API key. Create an API key under Settings → SMTP & API → API Keys.",
    );
  }
  if (apiKey.length < 20) {
    throw new Error("That Brevo key looks too short — paste the full key.");
  }

  const preferRest = looksLikeRestKey(apiKey);
  let restError = "";
  let mcpError = "";

  const tryRest = async () => {
    try {
      await probeRestAccount(apiKey, BREVO_REST);
      return true;
    } catch (err) {
      restError = err instanceof Error ? err.message : String(err);
      try {
        await probeRestAccount(apiKey, BREVO_REST_LEGACY);
        return true;
      } catch (legacyErr) {
        restError = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        return false;
      }
    }
  };

  const tryMcp = async () => {
    try {
      await validateBrevoMcp(apiKey, BREVO_MCP_DEFAULT);
      return true;
    } catch (err) {
      mcpError = err instanceof Error ? err.message : String(err);
      return false;
    }
  };

  if (preferRest) {
    if (await tryRest()) return { mcpUrl: "", verified: true };
    if (await tryMcp()) return { mcpUrl: BREVO_MCP_DEFAULT, verified: true };
  } else {
    if (await tryMcp()) return { mcpUrl: BREVO_MCP_DEFAULT, verified: true };
    if (await tryRest()) return { mcpUrl: "", verified: true };
  }

  const combined = `${restError}\n${mcpError}`;
  const ip = await outboundIp();
  const hint = brevoKeyHint(apiKey);

  // Soft-save: do not block Connect on live 401s — store key in the mode that matches its shape.
  const mcpUrl = preferRest ? "" : BREVO_MCP_DEFAULT;
  let warning =
    `Saved Brevo key ${hint} without live verification. ` +
    `REST: ${restError.slice(0, 160) || "n/a"} | MCP: ${mcpError.slice(0, 160) || "n/a"}.`;

  if (isBrevoIpAuthorizationError(combined) || /\b401\b/.test(combined)) {
    warning +=
      ` If campaigns fail, authorize server IP${ip ? ` ${ip}` : ""} in Brevo → Settings → Security → Authorized IPs ` +
      `(or disable API IP blocking), and confirm you used an API/MCP key — not SMTP.`;
  }

  return { mcpUrl, verified: false, warning };
}
