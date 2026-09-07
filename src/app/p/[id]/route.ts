import { NextResponse } from "next/server";
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

  return new NextResponse(share.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
