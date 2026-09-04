import { redirect } from "next/navigation";
import { ProjectChat } from "@/components/ProjectChat";
import { UserDashboard } from "@/components/UserDashboard";
import { getSession } from "@/lib/session";
import { loadAssignedProjects, loadProjectChat } from "@/lib/user-workspace";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  if (!session || session.role !== "user") redirect("/");

  const projects = await loadAssignedProjects(session.userId);
  const first = projects[0];
  if (!first) {
    return <UserDashboard user={session} projects={[]} />;
  }

  const chat = await loadProjectChat(session, String(first._id));
  if (!chat) {
    return <UserDashboard user={session} projects={[]} />;
  }

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
