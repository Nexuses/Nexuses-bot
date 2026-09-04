import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { jsonError, isEmail } from "@/lib/api";
import { verifyPassword } from "@/lib/password";
import { setSessionCookie, signToken } from "@/lib/session";
import { User } from "@/models/User";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!isEmail(email) || !password) return jsonError("Email and password are required");

    await dbConnect();
    const user = await User.findOne({ email, role: "admin" });
    if (!user || !(await verifyPassword(password, user.password))) {
      return jsonError("Invalid admin credentials", 401);
    }

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
    return jsonError("Could not sign in", 500);
  }
}
