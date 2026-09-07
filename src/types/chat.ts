export type Provider = "attio" | "brevo" | "lemlist" | "other";
export type AuthType = "bearer" | "api-key" | "basic";

export type IntegrationDTO = {
  _id: string;
  provider: Provider;
  name: string;
  baseUrl: string;
  mcpUrl: string;
  authType: AuthType;
  keyHint: string;
  /** True when a classic Brevo REST API key is saved alongside MCP. */
  hasRestApiKey?: boolean;
};

export type ChatAttachment = {
  name: string;
  type: string;
  size: number;
};

export type ChatThreadDTO = {
  _id: string;
  title: string;
  updatedAt: string;
};

export type ChatMessageDTO = {
  _id: string;
  role: "user" | "assistant";
  content: string;
  toolsUsed: string[];
  attachments: ChatAttachment[];
  createdAt: string;
};
