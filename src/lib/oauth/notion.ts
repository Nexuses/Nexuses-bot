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

/** Prefer the live request host so local ≠ prod aren't stuck on APP_URL=localhost. */
export function notionRedirectUri(requestOrigin?: string) {
  const fromRequest = (requestOrigin || "").trim().replace(/\/$/, "");
  if (fromRequest && /^https?:\/\//i.test(fromRequest)) {
    return `${fromRequest}/api/oauth/notion/callback`;
  }
  const fromEnv = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (fromEnv) return `${fromEnv}/api/oauth/notion/callback`;
  return "http://localhost:3000/api/oauth/notion/callback";
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
