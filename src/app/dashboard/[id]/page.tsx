import { redirect } from "next/navigation";
import mongoose from "mongoose";
import { ProjectChat } from "@/components/ProjectChat";
import { getSession } from "@/lib/session";
import { loadProjectChat } from "@/lib/user-workspace";

export const dynamic = "force-dynamic";

export default async function ProjectChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ chat?: string }>;
}) {
  const session = await getSession();
  if (!session || session.role !== "user") redirect("/");

  const { id } = await params;
  const { chat: chatId } = await searchParams;
  if (!mongoose.Types.ObjectId.isValid(id)) redirect("/dashboard");

  const chat = await loadProjectChat(session, id, chatId);
  if (!chat) redirect("/dashboard");

  return (
    <ProjectChat
      user={session}
      project={chat.project}
      projects={chat.projects}
      initialMessages={chat.initialMessages}
      initialIntegrations={chat.initialIntegrations}
      initialChats={chat.initialChats}
      initialChatId={chat.initialChatId}
    />
  );
}
