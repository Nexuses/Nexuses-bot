import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { getOauthConnector, isOauthProvider } from "@/lib/oauth/catalog";
import {
  buildNotionAuthorizeUrl,
  notionOauthConfigured,
  notionPublicOrigin,
  notionRedirectUri,
} from "@/lib/oauth/notion";
import { signOauthState } from "@/lib/oauth/state";
import { getSession } from "@/lib/session";
import { dbConnect } from "@/lib/db";
import { Project } from "@/models/Project";

type Params = { params: Promise<{ provider: string }> };

function requestOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) {
    const proto =
      forwardedProto ||
      (forwardedHost.startsWith("localhost") || forwardedHost.startsWith("127.")
        ? "http"
        : "https");
    return `${proto}://${forwardedHost}`;
  }
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest, { params }: Params) {
  const { provider: rawProvider } = await params;
  const provider = rawProvider.trim().toLowerCase();
  const projectId = request.nextUrl.searchParams.get("projectId") || "";
  const detected = requestOrigin(request);
  const origin = notionPublicOrigin(detected);

  if (!isOauthProvider(provider)) {
    return NextResponse.redirect(
      new URL(`/dashboard?oauth_error=${encodeURIComponent("Unknown connector")}`, origin),
    );
  }

  const session = await getSession();
  if (!session || session.role !== "user") {
    return NextResponse.redirect(new URL("/", origin));
  }

  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return NextResponse.redirect(
      new URL(`/dashboard?oauth_error=${encodeURIComponent("Missing project")}`, origin),
    );
  }

  await dbConnect();
  const project = await Project.findOne({
    _id: projectId,
    members: session.userId,
  })
    .select("_id")
    .lean();
  if (!project) {
    return NextResponse.redirect(
      new URL(`/dashboard?oauth_error=${encodeURIComponent("Project not found")}`, origin),
    );
  }

  if (provider === "notion" && !notionOauthConfigured()) {
    return NextResponse.redirect(
      new URL(
        `/dashboard/${projectId}?oauth_error=${encodeURIComponent(
          "Notion OAuth is not configured. Add NOTION_CLIENT_ID and NOTION_CLIENT_SECRET.",
        )}`,
        origin,
      ),
    );
  }

  const redirectUri = notionRedirectUri(detected);
  const state = await signOauthState({
    userId: session.userId,
    projectId,
    provider,
    redirectUri,
  });

  if (provider === "notion") {
    const url = buildNotionAuthorizeUrl({ state, redirectUri });
    return NextResponse.redirect(url);
  }

  const connector = getOauthConnector(provider);
  return NextResponse.redirect(
    new URL(
      `/dashboard/${projectId}?oauth_error=${encodeURIComponent(
        `${connector?.title || provider} is not ready yet`,
      )}`,
      origin,
    ),
  );
}
