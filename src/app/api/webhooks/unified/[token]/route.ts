import { handleUnifiedWebhookToken } from "@/lib/automations";

type Params = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: Params) {
  const { token } = await params;
  if (!token || token.length < 8) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const rawBody = await request.text();
  const signatureHeader =
    request.headers.get("x-unified-signature") || request.headers.get("X-Unified-Signature");

  const result = await handleUnifiedWebhookToken({
    token,
    rawBody,
    signatureHeader,
  });

  if (!result.ok) {
    const status = result.error === "Invalid signature" ? 401 : 404;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({ ok: true, updated: result.updated, type: result.type });
}
