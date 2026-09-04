import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { listChats } from "@/lib/chats";
import { serializeIntegration } from "@/lib/serialize-integration";
import { serializeMessage } from "@/lib/serialize-message";
import { serializeProject } from "@/lib/serialize";
import { Integration } from "@/models/Integration";
import { Message } from "@/models/Message";
import { Project } from "@/models/Project";
import type { SessionUser } from "@/types";

function memberFilter(userId: string) {
  if (mongoose.Types.ObjectId.isValid(userId)) {
    return { members: { $in: [userId, new mongoose.Types.ObjectId(userId)] } };
  }
  return { members: userId };
}

export async function loadAssignedProjects(userId: string) {
  await dbConnect();
  return Project.find(memberFilter(userId))
    .populate("members", "name email")
    .sort({ createdAt: -1 })
    .lean();
}

export async function loadProjectChat(
  session: SessionUser,
  projectId: string,
  chatId?: string,
) {
  await dbConnect();
  const [chats, integrations, projects] = await Promise.all([
    listChats(session.userId, projectId),
    Integration.find({ userId: session.userId, projectId }).lean(),
    loadAssignedProjects(session.userId),
  ]);

  const project = projects.find((item) => String(item._id) === projectId);
  if (!project) return null;

  const activeChatId =
    (chatId && chats.some((item) => item._id === chatId) ? chatId : chats[0]?._id) || "";

  const messages = activeChatId
    ? await Message.find({
        userId: session.userId,
        projectId,
        chatId: activeChatId,
      })
        .sort({ createdAt: 1 })
        .limit(200)
        .lean()
    : [];

  return {
    project: serializeProject(project),
    projects: projects.map(serializeProject),
    initialMessages: messages.map(serializeMessage),
    initialIntegrations: integrations.map(serializeIntegration),
    initialChats: chats,
    initialChatId: activeChatId,
  };
}
