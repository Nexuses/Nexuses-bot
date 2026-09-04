import { jsonError } from "@/lib/api";
import { getOwnedChat } from "@/lib/chats";
import { ok, requireProjectMember } from "@/lib/project-access";
import { Message } from "@/models/Message";

type Params = { params: Promise<{ id: string; chatId: string }> };

export async function DELETE(_request: Request, { params }: Params) {
  const { id, chatId } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  const chat = await getOwnedChat(session.userId, id, chatId);
  if (!chat) return jsonError("Chat not found", 404);

  await Message.deleteMany({ chatId: chat._id, userId: session.userId, projectId: id });
  await chat.deleteOne();
  return ok({ ok: true });
}
