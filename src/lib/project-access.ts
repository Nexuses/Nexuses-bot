import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { jsonError, requireRole } from "@/lib/api";
import { Project } from "@/models/Project";

function memberFilter(userId: string) {
  if (mongoose.Types.ObjectId.isValid(userId)) {
    return { members: { $in: [userId, new mongoose.Types.ObjectId(userId)] } };
  }
  return { members: userId };
}

export async function requireProjectMember(projectId: string) {
  const { session, error } = await requireRole("user");
  if (error || !session) {
    return { session: null, project: null, error: error ?? jsonError("Unauthorized", 401) };
  }

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return { session: null, project: null, error: jsonError("Invalid project", 400) };
  }

  await dbConnect();
  const project = await Project.findOne({
    _id: projectId,
    ...memberFilter(session.userId),
  });

  if (!project) {
    return { session: null, project: null, error: jsonError("Project not found", 404) };
  }

  return { session, project, error: null };
}

export function ok(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}
