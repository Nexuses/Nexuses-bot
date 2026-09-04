import type { AuthType, IntegrationDTO, Provider } from "@/types/chat";

type LeanIntegration = {
  _id: unknown;
  provider: Provider;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  mcpUrl?: string;
  authType?: AuthType;
};

export function maskKey(key: string) {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "saved";
  return `••••${trimmed.slice(-4)}`;
}

export function serializeIntegration(doc: LeanIntegration): IntegrationDTO {
  return {
    _id: String(doc._id),
    provider: doc.provider,
    name: doc.name,
    baseUrl: doc.baseUrl ?? "",
    mcpUrl: doc.mcpUrl ?? "",
    authType: doc.authType ?? "bearer",
    keyHint: maskKey(doc.apiKey ?? ""),
  };
}
