import type { ChatAttachment, ChatMessageDTO } from "@/types/chat";

export function serializeMessage(message: {
  _id: unknown;
  role: string;
  content: string;
  toolsUsed?: string[];
  attachments?: ChatAttachment[];
  createdAt?: Date;
}): ChatMessageDTO {
  return {
    _id: String(message._id),
    role: message.role as "user" | "assistant",
    content: message.content,
    toolsUsed: message.toolsUsed ?? [],
    attachments: (message.attachments ?? []).map((item) => ({
      name: item.name,
      type: item.type,
      size: item.size,
    })),
    createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : "",
  };
}
