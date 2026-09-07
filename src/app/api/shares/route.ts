import { jsonError, requireRole } from "@/lib/api";
import { createHtmlShare } from "@/lib/html-shares";
import { ok } from "@/lib/project-access";

export async function POST(request: Request) {
  const { session, error } = await requireRole("user");
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  try {
    const body = await request.json().catch(() => null);
    const html = String(body?.html ?? "");
    const title = String(body?.title ?? "").trim();
    const projectId = String(body?.projectId ?? "").trim();
    const origin = new URL(request.url).origin;

    const share = await createHtmlShare({
      userId: session.userId,
      projectId: projectId || undefined,
      html,
      title: title || undefined,
      origin,
    });

    return ok({ share }, 201);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not create share link", 400);
  }
}
