import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { Chat } from "@/models/Chat";
import { Message } from "@/models/Message";
import type { ChatThreadDTO } from "@/types/chat";

export function serializeChat(doc: {
  _id: unknown;
  title?: string;
  updatedAt?: Date;
}): ChatThreadDTO {
  return {
    _id: String(doc._id),
    title: doc.title?.trim() || "New chat",
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : "",
  };
}

const SMALL_WORDS = new Set(["a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "with", "from", "at"]);
const PROPER_WORDS = new Set(["attio", "brevo", "lemlist", "nexuses", "csv", "pdf", "api"]);
const LEADING_FLUFF = [
  /^please\s+/i,
  /^(hey|hi|hello)[,!\s]+/i,
  /^(can|could|would|will)\s+you\s+(please\s+)?/i,
  /^i\s+(just\s+)?(want|needed|need|would like)(\s+you)?(\s+to)?\s+/i,
  /^what\s+i\s+want\s+is\s+/i,
  /^i\s+have\s+integrated\s+(the\s+)?\w+\s*/i,
  /^(so|and|also|ok|okay)[,!\s]+/i,
];

function titleCaseWord(word: string, index: number) {
  const letters = word.replace(/[^a-zA-Z0-9]/g, "");
  const lower = letters.toLowerCase();
  if (!lower) return word;
  if (PROPER_WORDS.has(lower)) {
    const pretty =
      lower === "csv" || lower === "pdf" || lower === "api"
        ? lower.toUpperCase()
        : lower[0].toUpperCase() + lower.slice(1);
    return word.replace(letters, pretty);
  }
  if (/^[A-Z0-9]{2,}$/.test(letters) && letters.length <= 5) return word;
  if (index !== 0 && SMALL_WORDS.has(lower)) {
    return word.replace(letters, lower);
  }
  return word.replace(letters, letters[0].toUpperCase() + letters.slice(1).toLowerCase());
}

export function titleFromText(text: string) {
  let clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  clean = clean.split(/[.?!]\s/)[0]?.trim() || clean;

  for (let i = 0; i < 5; i += 1) {
    const next = LEADING_FLUFF.reduce((value, pattern) => value.replace(pattern, ""), clean).trim();
    if (next === clean) break;
    clean = next;
  }

  clean = clean.replace(/[,:\s]*please[.!]?$/i, "").trim();
  const words = clean.split(" ").filter(Boolean).slice(0, 6);
  if (!words.length) return "New chat";

  const title = words.map(titleCaseWord).join(" ");
  return title.length > 40 ? `${title.slice(0, 39).trim()}…` : title;
}

function orphanFilter(userId: string, projectId: string) {
  return {
    userId,
    projectId,
    $or: [{ chatId: { $exists: false } }, { chatId: null }],
  };
}

export async function listChats(userId: string, projectId: string) {
  await dbConnect();
  const orphan = await Message.findOne(orphanFilter(userId, projectId)).sort({ createdAt: 1 }).lean();
  if (orphan) {
    const firstUser = await Message.findOne({
      ...orphanFilter(userId, projectId),
      role: "user",
    })
      .sort({ createdAt: 1 })
      .lean();
    const chat = await Chat.create({
      userId,
      projectId,
      title: titleFromText(firstUser?.content || "Previous chat"),
    });
    await Message.updateMany(orphanFilter(userId, projectId), { $set: { chatId: chat._id } });
  }

  const chats = await Chat.find({ userId, projectId }).sort({ updatedAt: -1 }).lean();
  return chats.map(serializeChat);
}

export async function getOwnedChat(userId: string, projectId: string, chatId: string) {
  await dbConnect();
  if (!mongoose.Types.ObjectId.isValid(chatId)) return null;
  return Chat.findOne({ _id: chatId, userId, projectId });
}
