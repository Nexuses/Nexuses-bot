const NOTION_AUTH = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN = "https://api.notion.com/v1/oauth/token";
const NOTION_API = "https://api.notion.com";
export const NOTION_VERSION = "2022-06-28";

export function notionOauthConfigured() {
  return Boolean(
    (process.env.NOTION_CLIENT_ID || "").trim() &&
      (process.env.NOTION_CLIENT_SECRET || "").trim(),
  );
}

export function notionClientId() {
  const id = (process.env.NOTION_CLIENT_ID || "").trim();
  if (!id) throw new Error("NOTION_CLIENT_ID is not set");
  return id;
}

export function notionClientSecret() {
  const secret = (process.env.NOTION_CLIENT_SECRET || "").trim();
  if (!secret) throw new Error("NOTION_CLIENT_SECRET is not set");
  return secret;
}

/** Public origin for OAuth. Prefer APP_URL (canonical per deploy); never use https://localhost. */
export function notionPublicOrigin(requestOrigin?: string) {
  const rawEnv = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  const rawRequest = (requestOrigin || "").trim();

  const hostOf = (origin: string) => {
    try {
      return new URL(origin).hostname.toLowerCase();
    } catch {
      return "";
    }
  };
  const isLoopback = (origin: string) => {
    const host = hostOf(origin);
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  };

  /** Ensure scheme exists — APP_URL=bot.example.com must become https://bot.example.com */
  const normalize = (raw: string) => {
    if (!raw) return "";
    let value = raw.replace(/\/$/, "");
    if (!/^https?:\/\//i.test(value)) {
      const host = value.split("/")[0]?.toLowerCase() || "";
      const loopback =
        host === "localhost" ||
        host.startsWith("localhost:") ||
        host === "127.0.0.1" ||
        host.startsWith("127.0.0.1:");
      value = `${loopback ? "http" : "https"}://${value}`;
    }
    try {
      const url = new URL(value);
      if (isLoopback(url.origin) && url.protocol === "https:") {
        url.protocol = "http:";
      }
      return url.origin; // scheme + host + port only
    } catch {
      return "";
    }
  };

  const fromEnv = normalize(rawEnv);
  const fromRequest = normalize(rawRequest);

  if (fromEnv) return fromEnv;
  if (fromRequest && !isLoopback(fromRequest)) return fromRequest;
  if (fromRequest) return fromRequest;
  return "http://localhost:3000";
}

export function notionRedirectUri(requestOrigin?: string) {
  return `${notionPublicOrigin(requestOrigin)}/api/oauth/notion/callback`;
}

export function buildNotionAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
}) {
  const params = new URLSearchParams({
    client_id: notionClientId(),
    response_type: "code",
    owner: "user",
    redirect_uri: input.redirectUri,
    state: input.state,
  });
  return `${NOTION_AUTH}?${params.toString()}`;
}

export type NotionTokenResponse = {
  access_token: string;
  token_type?: string;
  bot_id?: string;
  workspace_id?: string;
  workspace_name?: string | null;
  workspace_icon?: string | null;
  duplicated_template_id?: string | null;
  owner?: unknown;
};

export async function exchangeNotionCode(input: {
  code: string;
  redirectUri: string;
}) {
  const basic = Buffer.from(`${notionClientId()}:${notionClientSecret()}`).toString(
    "base64",
  );
  const res = await fetch(NOTION_TOKEN, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
    }),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion OAuth failed: ${res.status} ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as NotionTokenResponse;
}

export function notionHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
}

export async function notionRequest(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const url = path.startsWith("http")
    ? path
    : `${NOTION_API}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: notionHeaders(accessToken),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  }
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
