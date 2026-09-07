import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/jwt";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifyToken(token) : null;

  if (pathname === "/") {
    if (session?.role === "user") {
      return NextResponse.redirect(new URL("/dashboard", request.url));
    }
    if (session?.role === "admin") {
      return NextResponse.redirect(new URL("/admin/dashboard", request.url));
    }
  }

  if (pathname === "/admin/signup") {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  if (pathname === "/admin") {
    if (session?.role === "admin") {
      return NextResponse.redirect(new URL("/admin/dashboard", request.url));
    }
  }

  if (pathname.startsWith("/admin/dashboard")) {
    if (!session || session.role !== "admin") {
      return NextResponse.redirect(new URL("/admin", request.url));
    }
  }

  if (pathname.startsWith("/dashboard")) {
    if (!session || session.role !== "user") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/dashboard/:path*", "/admin", "/admin/signup", "/admin/dashboard/:path*"],
};
