import { NextResponse } from "next/server";
import { renderHtmlSharePage } from "@/lib/html-shares";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const page = await renderHtmlSharePage(id);
  if (!page) {
    return new NextResponse("Not found", { status: 404 });
  }

  return new NextResponse(page.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
