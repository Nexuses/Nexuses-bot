import { redirect } from "next/navigation";
import { AdminDashboard } from "@/components/AdminDashboard";
import { dbConnect } from "@/lib/db";
import { serializeProject, serializeUser } from "@/lib/serialize";
import { getSession } from "@/lib/session";
import { Project } from "@/models/Project";
import { User } from "@/models/User";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const session = await getSession();
  if (!session || session.role !== "admin") redirect("/admin");

  await dbConnect();
  const [projects, users] = await Promise.all([
    Project.find().populate("members", "name email").sort({ createdAt: -1 }).lean(),
    User.find({ role: "user" }).select("name email createdAt").sort({ createdAt: -1 }).lean(),
  ]);

  return (
    <AdminDashboard
      admin={session}
      initialProjects={projects.map(serializeProject)}
      initialUsers={users.map(serializeUser)}
    />
  );
}
