import { jsonError } from "@/lib/api";
import {
  displayProviderName,
  isLikelyApiAuthRejection,
  looksLikeQueryApiKeyAuth,
  normalizeBrevoApiKey,
  normalizeCustomBaseUrl,
  normalizeMcpUrl,
  parseAuthType,
  upsertIntegrationDoc,
} from "@/lib/integrations";
import { ok, requireProjectMember } from "@/lib/project-access";
import { serializeIntegration } from "@/lib/serialize-integration";
import { validateIntegration } from "@/lib/tools";
import { Integration } from "@/models/Integration";
import type { Provider } from "@/types/chat";

const PROVIDERS = new Set<Provider>(["attio", "brevo", "lemlist", "notion", "other"]);

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  const integrations = await Integration.find({
    userId: session.userId,
    projectId: id,
  }).lean();

  return ok({ integrations: integrations.map(serializeIntegration) });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  try {
    const body = await request.json();
    const provider = String(body.provider ?? "") as Provider;
    let apiKey = String(body.apiKey ?? "").trim();
    let authType = parseAuthType(body.authType);
    const name =
      provider === "other"
        ? String(body.name ?? "").trim()
        : displayProviderName(provider);
    let baseUrl =
      provider === "other"
        ? normalizeCustomBaseUrl(name, String(body.baseUrl ?? ""))
        : String(body.baseUrl ?? "").trim().replace(/\/$/, "");

    if (provider === "other" && looksLikeQueryApiKeyAuth({ name, baseUrl, authType })) {
      authType = "query";
      if (!baseUrl) baseUrl = "https://server.smartlead.ai/api/v1";
    }

    if (!PROVIDERS.has(provider)) return jsonError("Choose Attio, Brevo, Lemlist, Notion, or Other");
    if (provider === "notion") {
      return jsonError(
        "Connect Notion with the Connect Notion button (OAuth). Or paste an internal integration token in chat.",
      );
    }
    if (!apiKey) return jsonError("API key is required");
    if (provider === "brevo") {
      apiKey = normalizeBrevoApiKey(apiKey);
      if (!apiKey) return jsonError("API key is required");
    }
    if (provider === "other" && name.length < 2) return jsonError("Give this API a name");

    const validated = await validateIntegration({ provider, apiKey, baseUrl, authType });

    let saved;
    if (provider === "brevo") {
      const existing = await Integration.findOne({
        userId: session.userId,
        projectId: id,
        provider: "brevo",
      });
      const isRestKey = !validated.mcpUrl;
      if (existing?.mcpUrl && isRestKey) {
        saved = await upsertIntegrationDoc({
          userId: session.userId,
          projectId: id,
          provider,
          name,
          apiKey,
          restOnly: true,
        });
      } else if (existing && !existing.mcpUrl && validated.mcpUrl) {
        saved = await upsertIntegrationDoc({
          userId: session.userId,
          projectId: id,
          provider,
          name,
          apiKey,
          restApiKey: existing.apiKey,
          mcpUrl: validated.mcpUrl,
          authType,
        });
      } else {
        saved = await upsertIntegrationDoc({
          userId: session.userId,
          projectId: id,
          provider,
          name,
          apiKey,
          restApiKey: existing?.restApiKey || "",
          mcpUrl: validated.mcpUrl ?? "",
          authType,
        });
      }
    } else {
      saved = await upsertIntegrationDoc({
        userId: session.userId,
        projectId: id,
        provider,
        name,
        apiKey,
        baseUrl,
        mcpUrl: normalizeMcpUrl(String(body.mcpUrl ?? "")),
        authType,
      });
    }

    const { apiKey: _apiKey, restApiKey: _rest, ...integration } = saved as typeof saved & {
      restApiKey?: string;
    };
    return ok({ integration }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save integration";
    if (isLikelyApiAuthRejection(message)) {
      return jsonError(
        message.includes("Brevo")
          ? message
          : "API key was rejected. Check the key and paste only the raw token (no Bearer prefix).",
        400,
      );
    }
    return jsonError(message, 400);
  }
}
