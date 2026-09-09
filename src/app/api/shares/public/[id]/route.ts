import { NextResponse } from "next/server";
import { getHtmlShareByPublicId, renderHtmlSharePage } from "@/lib/html-shares";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const page = await renderHtmlSharePage(id);
  if (!page) {
    return NextResponse.json({ error: "Share not found" }, { status: 404 });
  }

  const meta = await getHtmlShareByPublicId(id);
  return NextResponse.json(
    {
      publicId: id,
      title: page.title || meta?.title || "Shared report",
      html: page.html,
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
      },
    },
  );
}
