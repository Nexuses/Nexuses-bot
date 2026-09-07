import { NextResponse } from "next/server";
import { renderHtmlSharePage } from "@/lib/html-shares";

type Params = { params: Promise<{ id: string }> };

function notFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Link not found · Nexuses</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; font-family: ui-sans-serif, system-ui, sans-serif; background:#f6f3ee; color:#1c1916; }
  main { max-width:28rem; padding:2rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .75rem; }
  p { color:#6b6560; line-height:1.5; margin:0; }
</style>
</head>
<body>
<main>
  <h1>This share link was not found</h1>
  <p>It may have been invented by the chat, expired, or never published. Ask Nexuses again to create the dashboard and use the new live link (or the Share link button on the HTML preview).</p>
</main>
</body>
</html>`;
}

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !/^[A-Za-z0-9_-]{8,32}$/.test(id)) {
    return new NextResponse(notFoundPage(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const page = await renderHtmlSharePage(id);
  if (!page) {
    return new NextResponse(notFoundPage(), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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
