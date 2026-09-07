import { jsonError } from "@/lib/api";
import {
  displayProviderName,
  normalizeMcpUrl,
  parseAuthType,
  upsertIntegrationDoc,
} from "@/lib/integrations";
import { ok, requireProjectMember } from "@/lib/project-access";
import { serializeIntegration } from "@/lib/serialize-integration";
import { validateIntegration } from "@/lib/tools";
import { Integration } from "@/models/Integration";
import type { Provider } from "@/types/chat";

const PROVIDERS = new Set<Provider>(["attio", "brevo", "lemlist", "other"]);

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
    const apiKey = String(body.apiKey ?? "").trim();
    const baseUrl = String(body.baseUrl ?? "").trim().replace(/\/$/, "");
    const authType = parseAuthType(body.authType);
    const name =
      provider === "other"
        ? String(body.name ?? "").trim()
        : displayProviderName(provider);

    if (!PROVIDERS.has(provider)) return jsonError("Choose Attio, Brevo, Lemlist, or Other");
    if (!apiKey) return jsonError("API key is required");
    if (provider === "other" && name.length < 2) return jsonError("Give this API a name");

    const validated = await validateIntegration({ provider, apiKey, baseUrl, authType });
    const mcpUrl =
      provider === "brevo"
        ? validated.mcpUrl ?? ""
        : normalizeMcpUrl(String(body.mcpUrl ?? ""));

    const saved = await upsertIntegrationDoc({
      userId: session.userId,
      projectId: id,
      provider,
      name,
      apiKey,
      baseUrl,
      mcpUrl,
      authType,
    });

    const { apiKey: _apiKey, ...integration } = saved;
    return ok({ integration }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save integration";
    return jsonError(message.includes("401") || message.includes("403") ? "API key was rejected" : message, 400);
  }
}
