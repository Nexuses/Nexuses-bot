import type { Provider } from "@/types/chat";

export type OauthConnector = {
  provider: Extract<Provider, "notion">;
  title: string;
  blurb: string;
  authorizeHost: string;
};

/** Built-in OAuth connectors (Grok-style Connect → authorize). */
export const OAUTH_CONNECTORS: OauthConnector[] = [
  {
    provider: "notion",
    title: "Notion",
    blurb: "Pages, databases, and search — connect with Notion OAuth",
    authorizeHost: "api.notion.com",
  },
];

export function getOauthConnector(provider: string) {
  const key = provider.trim().toLowerCase();
  return OAUTH_CONNECTORS.find((item) => item.provider === key) || null;
}

export function isOauthProvider(provider: string): provider is Extract<Provider, "notion"> {
  return Boolean(getOauthConnector(provider));
}
