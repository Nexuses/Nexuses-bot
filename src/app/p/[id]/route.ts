import { NextResponse } from "next/server";
import { enhanceSharedHtml } from "@/lib/html-dashboard-kit";
import { getHtmlShareByPublicId } from "@/lib/html-shares";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const share = await getHtmlShareByPublicId(id);
  if (!share) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Re-enhance older shares that were saved as bare/markdown-ish HTML.
  const html = enhanceSharedHtml(String(share.html || ""), share.title || "Nexuses dashboard");

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
