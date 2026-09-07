import { NextRequest, NextResponse } from "next/server";
import { isOauthProvider } from "@/lib/oauth/catalog";
import { exchangeNotionCode } from "@/lib/oauth/notion";
import { verifyOauthState } from "@/lib/oauth/state";
import { upsertIntegrationDoc } from "@/lib/integrations";
import { dbConnect } from "@/lib/db";
import { getSession } from "@/lib/session";

type Params = { params: Promise<{ provider: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { provider: rawProvider } = await params;
  const provider = rawProvider.trim().toLowerCase();
  const origin = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get("code") || "";
  const stateToken = request.nextUrl.searchParams.get("state") || "";
  const oauthError = request.nextUrl.searchParams.get("error") || "";

  if (!isOauthProvider(provider)) {
    return NextResponse.redirect(
      new URL(`/dashboard?oauth_error=${encodeURIComponent("Unknown connector")}`, origin),
    );
  }

  const state = await verifyOauthState(stateToken);
  if (!state || state.provider !== provider) {
    return NextResponse.redirect(
      new URL(`/dashboard?oauth_error=${encodeURIComponent("Invalid or expired OAuth state")}`, origin),
    );
  }

  const fail = (message: string) =>
    NextResponse.redirect(
      new URL(
        `/dashboard/${state.projectId}?oauth_error=${encodeURIComponent(message)}`,
        origin,
      ),
    );

  if (oauthError) {
    return fail(oauthError === "access_denied" ? "Authorization was cancelled" : oauthError);
  }
  if (!code) return fail("Missing authorization code");

  const session = await getSession();
  if (!session || session.userId !== state.userId) {
    return NextResponse.redirect(new URL("/", origin));
  }

  try {
    await dbConnect();
    if (provider === "notion") {
      const token = await exchangeNotionCode({ code, origin });
      if (!token.access_token) throw new Error("Notion did not return an access token");
      const workspace = (token.workspace_name || "").trim();
      await upsertIntegrationDoc({
        userId: state.userId,
        projectId: state.projectId,
        provider: "notion",
        name: workspace ? `Notion (${workspace})` : "Notion",
        apiKey: token.access_token,
        authType: "bearer",
      });
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : "OAuth failed");
  }

  return NextResponse.redirect(
    new URL(`/dashboard/${state.projectId}?connected=${provider}`, origin),
  );
}
