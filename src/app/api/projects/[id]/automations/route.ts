import { jsonError } from "@/lib/api";
import {
  ensureAutomationRunner,
  listAutomations,
  startCampaignAutomation,
  stopAutomation,
} from "@/lib/automations";
import { ok, requireProjectMember } from "@/lib/project-access";
import type { SyncRecipe } from "@/lib/serialize-automation";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  ensureAutomationRunner();
  const automations = await listAutomations(session.userId, id);
  return ok({ automations });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  try {
    const body = await request.json();
    const action = String(body.action || "start").toLowerCase();

    if (action === "stop") {
      const stopped = await stopAutomation({
        userId: session.userId,
        projectId: id,
        automationId: String(body.automationId || "").trim() || undefined,
        campaignName: String(body.campaignName || "").trim() || undefined,
      });
      return ok({ automation: stopped });
    }

    const rawSource = String(body.sourceProvider || body.provider || body.source || "lemlist").trim();
    const lower = rawSource.toLowerCase();
    let sourceProvider: "lemlist" | "brevo" | "other";
    let sourceIntegrationName = String(body.integration || body.sourceIntegrationName || "").trim();

    if (lower === "lemlist") sourceProvider = "lemlist";
    else if (lower === "brevo") sourceProvider = "brevo";
    else {
      sourceProvider = "other";
      if (!sourceIntegrationName && lower !== "other" && lower !== "custom") {
        sourceIntegrationName = rawSource;
      }
      if (!sourceIntegrationName) {
        return jsonError("integration / sourceIntegrationName is required for custom sources");
      }
    }

    const campaignName = String(body.campaignName || body.campaign || "").trim();
    const attioList = String(body.attioList || body.list || "").trim();
    if (!campaignName) return jsonError("campaignName is required");
    if (!attioList) return jsonError("attioList is required");

    let recipe: SyncRecipe | undefined;
    if (sourceProvider === "other") {
      const pollPath = String(body.pollPath || body.poll_path || body.recipe?.pollPath || "").trim();
      if (!pollPath) return jsonError("pollPath is required for custom connector sync");
      const stageMapRaw = body.stageMap || body.stage_map || body.recipe?.stageMap;
      recipe = {
        pollPath,
        method:
          String(body.pollMethod || body.poll_method || body.recipe?.method || "GET").toUpperCase() ===
          "POST"
            ? "POST"
            : "GET",
        body: body.pollBody ?? body.poll_body ?? body.recipe?.body,
        itemsPath: String(body.itemsPath || body.items_path || body.recipe?.itemsPath || "").trim() || undefined,
        emailField:
          String(body.emailField || body.email_field || body.recipe?.emailField || "").trim() || undefined,
        nameField:
          String(body.nameField || body.name_field || body.recipe?.nameField || "").trim() || undefined,
        stageField:
          String(body.stageField || body.stage_field || body.recipe?.stageField || "").trim() || undefined,
        defaultStage:
          String(body.defaultStage || body.default_stage || body.recipe?.defaultStage || "").trim() ||
          undefined,
        stageMap:
          stageMapRaw && typeof stageMapRaw === "object"
            ? Object.fromEntries(
                Object.entries(stageMapRaw as Record<string, unknown>).map(([k, v]) => [
                  k,
                  String(v ?? ""),
                ]),
              )
            : undefined,
        completedPath:
          String(body.completedPath || body.completed_path || body.recipe?.completedPath || "").trim() ||
          undefined,
        completedValues: Array.isArray(body.completedValues || body.completed_values || body.recipe?.completedValues)
          ? (body.completedValues || body.completed_values || body.recipe?.completedValues).map(
              (item: unknown) => String(item || "").trim(),
            ).filter(Boolean)
          : undefined,
      };
    }

    const automation = await startCampaignAutomation({
      userId: session.userId,
      projectId: id,
      sourceProvider,
      sourceIntegrationName: sourceProvider === "other" ? sourceIntegrationName : undefined,
      campaignName,
      attioList,
      stageOpen: String(body.stageOpen || "open"),
      stageClick: String(body.stageClick || "click"),
      stageReply: String(body.stageReply || "hot"),
      intervalMinutes: Number(body.intervalMinutes) || 2,
      recipe,
    });
    return ok({ automation }, 201);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Automation failed", 400);
  }
}
