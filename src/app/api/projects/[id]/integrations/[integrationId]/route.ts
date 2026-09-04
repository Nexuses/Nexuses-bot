import mongoose from "mongoose";
import { jsonError } from "@/lib/api";
import { ok, requireProjectMember } from "@/lib/project-access";
import { Integration } from "@/models/Integration";

type Params = { params: Promise<{ id: string; integrationId: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  const { id, integrationId } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);
  if (!mongoose.Types.ObjectId.isValid(integrationId)) return jsonError("Invalid integration");

  const result = await Integration.findOneAndDelete({
    _id: integrationId,
    userId: session.userId,
    projectId: id,
  });

  if (!result) return jsonError("Integration not found", 404);
  return ok({ ok: true });
}
