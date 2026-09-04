import { jsonError } from "@/lib/api";
import { listChats, serializeChat } from "@/lib/chats";
import { ok, requireProjectMember } from "@/lib/project-access";
import { Chat } from "@/models/Chat";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);
  const chats = await listChats(session.userId, id);
  return ok({ chats });
}

export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const { session, error } = await requireProjectMember(id);
  if (error || !session) return error ?? jsonError("Unauthorized", 401);
  const chat = await Chat.create({
    userId: session.userId,
    projectId: id,
    title: "New chat",
  });
  return ok({ chat: serializeChat(chat) }, 201);
}
