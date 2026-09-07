import { jsonError } from "@/lib/api";
import {
  ensureAutomationRunner,
  listAutomations,
  startCampaignAutomation,
  stopAutomation,
} from "@/lib/automations";
import { ok, requireProjectMember } from "@/lib/project-access";

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

    const sourceProvider = String(body.sourceProvider || body.provider || "lemlist").toLowerCase();
    if (sourceProvider !== "lemlist" && sourceProvider !== "brevo") {
      return jsonError("sourceProvider must be lemlist or brevo");
    }
    const campaignName = String(body.campaignName || "").trim();
    const attioList = String(body.attioList || body.list || "").trim();
    if (!campaignName) return jsonError("campaignName is required");
    if (!attioList) return jsonError("attioList is required");

    const automation = await startCampaignAutomation({
      userId: session.userId,
      projectId: id,
      sourceProvider,
      campaignName,
      attioList,
      stageOpen: String(body.stageOpen || "open"),
      stageClick: String(body.stageClick || "click"),
      stageReply: String(body.stageReply || "hot"),
      intervalMinutes: Number(body.intervalMinutes) || 2,
    });
    return ok({ automation }, 201);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Automation failed", 400);
  }
}
