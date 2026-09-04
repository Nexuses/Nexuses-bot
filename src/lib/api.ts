import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import type { SessionUser } from "@/types";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireRole(role: SessionUser["role"]) {
  const session = await getSession();
  if (!session) {
    return { session: null, error: jsonError("Unauthorized", 401) };
  }
  if (session.role !== role) {
    return { session: null, error: jsonError("Forbidden", 403) };
  }
  return { session, error: null };
}

export function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
