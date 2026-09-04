import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { jsonError, isEmail } from "@/lib/api";
import { hashPassword } from "@/lib/password";
import { setSessionCookie, signToken } from "@/lib/session";
import { User } from "@/models/User";

export async function POST(request: Request) {
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
      role: "admin",
    });

    const token = await signToken({
      userId: String(user._id),
      name: user.name,
      email: user.email,
      role: "admin",
    });

    const response = NextResponse.json({
      user: { userId: String(user._id), name: user.name, email: user.email, role: "admin" },
    });
    setSessionCookie(response, token);
    return response;
  } catch {
    return jsonError("Could not create admin account", 500);
  }
}
