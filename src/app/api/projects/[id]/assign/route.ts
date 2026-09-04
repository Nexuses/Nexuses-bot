import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { dbConnect } from "@/lib/db";
import { jsonError, requireRole } from "@/lib/api";
import { serializeProject } from "@/lib/serialize";
import { Project } from "@/models/Project";
import { User } from "@/models/User";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { session, error } = await requireRole("admin");
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  const { id } = await params;
  if (!mongoose.Types.ObjectId.isValid(id)) return jsonError("Invalid project");

  try {
    const body = await request.json();
    const userIds = Array.isArray(body.userIds) ? body.userIds.map(String) : [];
    if (userIds.some((value: string) => !mongoose.Types.ObjectId.isValid(value))) {
      return jsonError("Invalid user id");
    }

    await dbConnect();
    const project = await Project.findById(id);
    if (!project) return jsonError("Project not found", 404);

    const users = await User.find({ _id: { $in: userIds }, role: "user" }).select("_id");
    if (users.length !== userIds.length) {
      return jsonError("Only existing users can be assigned");
    }

    project.members = users.map((user) => user._id);
    await project.save();

    const updated = await Project.findById(id).populate("members", "name email").lean();
    return NextResponse.json({ project: serializeProject(updated!) });
  } catch {
    return jsonError("Could not assign users", 500);
  }
}
