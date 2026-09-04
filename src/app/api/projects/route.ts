import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { jsonError, requireRole } from "@/lib/api";
import { getSession } from "@/lib/session";
import { serializeProject } from "@/lib/serialize";
import { Project } from "@/models/Project";

function isLogoUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function GET() {
  const session = await getSession();
  if (!session) return jsonError("Unauthorized", 401);

  await dbConnect();
  const query = session.role === "admin" ? {} : { members: session.userId };
  const projects = await Project.find(query)
    .populate("members", "name email")
    .sort({ createdAt: -1 })
    .lean();
  return NextResponse.json({ projects: projects.map(serializeProject) });
}

export async function POST(request: Request) {
  const { session, error } = await requireRole("admin");
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const logo = String(body.logo ?? "").trim();

    if (name.length < 2) return jsonError("Project name must be at least 2 characters");
    if (!isLogoUrl(logo)) return jsonError("Enter a valid logo URL");

    await dbConnect();
    const project = await Project.create({
      name,
      logo,
      createdBy: session.userId,
      members: [],
    });

    const created = await Project.findById(project._id).populate("members", "name email").lean();
    return NextResponse.json({ project: serializeProject(created!) }, { status: 201 });
  } catch {
    return jsonError("Could not create project", 500);
  }
}
