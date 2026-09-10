import { jsonError } from "@/lib/api";
import { ensureChatJobRunner, listProjectChatJobs } from "@/lib/chat-jobs";
import { requireProjectMember } from "@/lib/project-access";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, project, error } = await requireProjectMember(id);
  if (error || !session || !project) return error ?? jsonError("Unauthorized", 401);

  ensureChatJobRunner();

  const url = new URL(request.url);
  const chatId = String(url.searchParams.get("chatId") || "").trim();
  const activeOnly = url.searchParams.get("active") !== "0";

  const jobs = await listProjectChatJobs({
    userId: session.userId,
    projectId: id,
    chatId: chatId || undefined,
    activeOnly,
  });

  return Response.json({ jobs });
}
