import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { jsonError, isEmail, requireRole } from "@/lib/api";
import { hashPassword } from "@/lib/password";
import { serializeUser } from "@/lib/serialize";
import { User } from "@/models/User";

export async function GET() {
  const { session, error } = await requireRole("admin");
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  await dbConnect();
  const users = await User.find({ role: "user" })
    .select("name email createdAt")
    .sort({ createdAt: -1 })
    .lean();
  return NextResponse.json({ users: users.map(serializeUser) });
}

export async function POST(request: Request) {
  const { session, error } = await requireRole("admin");
  if (error || !session) return error ?? jsonError("Unauthorized", 401);

  try {
    const body = await request.json();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (name.length < 2) return jsonError("Name must be at least 2 characters");
    if (!isEmail(email)) return jsonError("Enter a valid email");
    if (password.length < 8) return jsonError("Password must be at least 8 characters");

    await dbConnect();
    const existing = await User.findOne({ email });
    if (existing) return jsonError("An account with this email already exists", 409);

    const user = await User.create({
      name,
      email,
      password: await hashPassword(password),
      role: "user",
    });

    return NextResponse.json({ user: serializeUser(user.toObject()) }, { status: 201 });
  } catch {
    return jsonError("Could not create user", 500);
  }
}
