import { handleSmartleadWebhookToken } from "@/lib/automations";

type Params = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  if (!token || token.length < 8) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const rawBody = await request.text();
  const result = await handleSmartleadWebhookToken({ token, rawBody });

  if (!result.ok) {
    const status = result.error === "Unknown webhook" ? 404 : 400;
    return Response.json({ error: result.error }, { status });
  }

  // SmartLead retries if not 200 — acknowledge quickly.
  return Response.json({
    ok: true,
    status: "received",
    updated: result.updated,
    type: result.type,
  });
}

/** Optional health check when pasting the URL in SmartLead UI. */
export async function GET(_request: Request, { params }: Params) {
  const { token } = await params;
  if (!token || token.length < 8) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({
    ok: true,
    service: "nexuses-smartlead-webhook",
    hint: "POST SmartLead events (EMAIL_SENT, EMAIL_OPEN, EMAIL_LINK_CLICK, …) to this URL.",
  });
}
