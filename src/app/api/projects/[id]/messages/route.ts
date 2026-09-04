import { jsonError } from "@/lib/api";
import { getOwnedChat, listChats } from "@/lib/chats";
import { ok, requireProjectMember } from "@/lib/project-access";
import { serializeMessage } from "@/lib/serialize-message";
import { Message } from "@/models/Message";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  const chatId = new URL(request.url).searchParams.get("chatId") || "";
  if (!chatId) {
    const chats = await listChats(session.userId, id);
    if (!chats[0]) return ok({ messages: [] });
    const messages = await Message.find({
      userId: session.userId,
      projectId: id,
      chatId: chats[0]._id,
    })
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();
    return ok({ messages: messages.map(serializeMessage), chatId: chats[0]._id });
  }

  const chat = await getOwnedChat(session.userId, id, chatId);
  if (!chat) return jsonError("Chat not found", 404);

  const messages = await Message.find({
    userId: session.userId,
    projectId: id,
    chatId: chat._id,
  })
    .sort({ createdAt: 1 })
    .limit(200)
    .lean();

  return ok({ messages: messages.map(serializeMessage), chatId });
}
