export const NEXUSES_LOGO_URL =
  "https://cdn-nexlink.s3.us-east-2.amazonaws.com/Nexuses-full-logo-dark_8d412ea3-bf11-4fc6-af9c-bee7e51ef494.png";

const KIT_MARK = "data-nexuses-kit";
const HEADER_MARK = "data-nexuses-report-header";

export type ShareEnhanceOptions = {
  titleHint?: string;
  clientLogoUrl?: string;
  clientName?: string;
};

const KIT_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet" />
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          ink: "#f6f3ee",
          panel: "#efeae2",
          paper: "#1c1916",
          muted: "#6b6560",
          line: "#ddd6cb",
          sea: "#1e8a7a",
          "sea-2": "#176f62",
        },
        fontFamily: {
          display: ["Plus Jakarta Sans", "ui-sans-serif", "system-ui", "sans-serif"],
          sans: ["DM Sans", "ui-sans-serif", "system-ui", "sans-serif"],
        },
        boxShadow: {
          soft: "0 18px 50px rgba(28, 25, 22, 0.08)",
        },
      },
    },
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #f6f3ee; color: #1c1916; font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif; }
  body { background-image: radial-gradient(circle at top left, rgba(30,138,122,0.10), transparent 42%), linear-gradient(180deg, #f6f3ee 0%, #efeae2 100%); }
  h1, h2, h3, .font-display {
    font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif;
    letter-spacing: -0.02em;
    font-weight: 700;
  }
  h1 { font-size: clamp(1.75rem, 3vw, 2.35rem); line-height: 1.15; max-width: 18ch; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.85rem 1rem; border-bottom: 1px solid #ddd6cb; vertical-align: top; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b6560; font-weight: 600; }
  tbody tr:hover { background: rgba(30,138,122,0.04); }
  .nx-shell { max-width: 1120px; margin: 0 auto; padding: 1.75rem 1.25rem 4rem; }
  .nx-card { background: rgba(255,255,255,0.72); border: 1px solid #ddd6cb; border-radius: 1.5rem; box-shadow: 0 18px 50px rgba(28,25,22,0.08); backdrop-filter: blur(8px); }
  .nx-stat { padding: 1.25rem 1.35rem; }
  .nx-stat .label { font-size: 0.75rem; color: #6b6560; text-transform: uppercase; letter-spacing: 0.06em; }
  .nx-stat .value { margin-top: 0.35rem; font-family: "Plus Jakarta Sans", sans-serif; font-size: 1.85rem; font-weight: 700; letter-spacing: -0.02em; }
  .nx-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.75rem; padding-bottom: 1.25rem; border-bottom: 1px solid #ddd6cb; }
  .nx-header img { display: block; height: 40px; width: auto; max-width: 180px; object-fit: contain; }
  .nx-header .nx-client-logo { height: 44px; max-width: 160px; }
  .nx-header .nx-client-fallback {
    font-family: "Plus Jakarta Sans", sans-serif;
    font-size: 0.85rem; font-weight: 700; color: #1e8a7a;
    letter-spacing: 0.04em; text-transform: uppercase;
    border: 1px solid #ddd6cb; border-radius: 999px; padding: 0.55rem 0.9rem; background: rgba(255,255,255,0.7);
  }
</style>
`.trim();

function extractTitle(html: string, fallback = "Nexuses dashboard") {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match?.[1]) return match[1].replace(/<[^>]+>/g, "").trim() || fallback;
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1?.[1]) return h1[1].replace(/<[^>]+>/g, "").trim() || fallback;
  return fallback;
}

function stripDocumentChrome(html: string) {
  let body = html.trim();
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1];
  body = body
    .replace(/<!doctype[^>]*>/i, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/i, "")
    .replace(/<\/?body[^>]*>/gi, "")
    .trim();
  return body;
}

/** Turn markdown-ish table pipes into a real HTML table when the model leaked markdown. */
export function markdownTablesToHtml(input: string) {
  const lines = input.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    const isRow = /\|/.test(line) && !/^\s*\|?\s*:?-{2,}/.test(line);
    const isSep = /^\s*\|?\s*:?-{2,}(\s*\|+\s*:?-{2,})+\s*\|?\s*$/.test(next);
    if (isRow && isSep) {
      const rows: string[] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i]);
        i += 1;
      }
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(rows[0] || "");
      const body = rows.slice(1).map(cells);
      out.push('<div class="nx-card overflow-x-auto"><table><thead><tr>');
      for (const cell of head) out.push(`<th>${escapeHtml(cell)}</th>`);
      out.push("</tr></thead><tbody>");
      for (const row of body) {
        out.push("<tr>");
        for (const cell of row) out.push(`<td>${escapeHtml(cell)}</td>`);
        out.push("</tr>");
      }
      out.push("</tbody></table></div>");
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export function buildReportHeader(options?: ShareEnhanceOptions) {
  const clientLogo = (options?.clientLogoUrl || "").trim();
  const clientName = (options?.clientName || "").trim() || "Client";
  const right = clientLogo
    ? `<img class="nx-client-logo" src="${escapeAttr(clientLogo)}" alt="${escapeAttr(clientName)} logo" referrerpolicy="no-referrer" />`
    : `<span class="nx-client-fallback">${escapeHtml(clientName)}</span>`;

  return `<header class="nx-header" ${HEADER_MARK}>
  <a href="https://nexuses.com" style="display:inline-flex;align-items:center" aria-label="Nexuses">
    <img src="${escapeAttr(NEXUSES_LOGO_URL)}" alt="Nexuses" referrerpolicy="no-referrer" />
  </a>
  ${right}
</header>`;
}

function looksStyled(html: string) {
  return (
    html.includes(KIT_MARK) ||
    /cdn\.tailwindcss\.com/i.test(html) ||
    /tailwindcss/i.test(html) ||
    (/stylesheet/i.test(html) && /class=["'][^"']{20,}/i.test(html))
  );
}

function replaceOrInjectHeader(body: string, options?: ShareEnhanceOptions) {
  const header = buildReportHeader(options);
  // Drop old text-only Nexuses brand label.
  let next = body.replace(/<p[^>]*class=["'][^"']*nx-brand[^"']*["'][^>]*>[\s\S]*?<\/p>/i, "");
  if (new RegExp(HEADER_MARK, "i").test(next)) {
    next = next.replace(new RegExp(`<header[^>]*${HEADER_MARK}[^>]*>[\\s\\S]*?<\\/header>`, "i"), header);
  } else {
    next = `${header}\n${next}`;
  }
  return next;
}

/**
 * Ensure shared HTML dashboards get Tailwind + Nexuses fonts/colors + Chart.js.
 * Header: Nexuses logo left, client/project logo right.
 */
export function enhanceSharedHtml(raw: string, options?: ShareEnhanceOptions | string) {
  const opts: ShareEnhanceOptions =
    typeof options === "string" ? { titleHint: options } : options || {};

  let html = raw.trim();
  if (!html) return html;

  html = markdownTablesToHtml(html);
  const title = opts.titleHint || extractTitle(html);

  if (looksStyled(html) && /<html[\s>]/i.test(html)) {
    let doc = html.includes(KIT_MARK) ? html : html.replace(/<html/i, `<html ${KIT_MARK}`);
    // Swap ultra-wide Syne if present.
    doc = doc
      .replace(/family=Syne[^"&]*/gi, "family=Plus+Jakarta+Sans:wght@500;600;700;800")
      .replace(/["']Syne["']/g, '"Plus Jakarta Sans"')
      .replace(/font-family:\s*Syne/gi, 'font-family: "Plus Jakarta Sans"');
    const bodyMatch = doc.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const newBody = replaceOrInjectHeader(bodyMatch[1], opts);
      doc = doc.replace(bodyMatch[0], `<body>${newBody}</body>`);
    }
    return doc;
  }

  const body = replaceOrInjectHeader(stripDocumentChrome(html), opts);
  return `<!DOCTYPE html>
<html lang="en" ${KIT_MARK}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${KIT_HEAD}
</head>
<body>
<main class="nx-shell">
  ${body}
</main>
</body>
</html>`;
}

export const HTML_DASHBOARD_PROMPT = `When creating HTML dashboards / reports / shareable pages:
- Output a COMPLETE HTML document in an \`\`\`html fence (DOCTYPE, html, head, body).
- Use Tailwind via CDN (cdn.tailwindcss.com) plus Chart.js (cdn.jsdelivr.net/npm/chart.js) when charts help.
- Fonts: Plus Jakarta Sans for headings (NOT Syne / ultra-wide fonts), DM Sans for body (Google Fonts).
- Palette: background #f6f3ee, text #1c1916, accent #1e8a7a, borders #ddd6cb. Avoid purple gradients, neon glow, and emoji decoration.
- Header (required): left = Nexuses logo image exactly at
  ${NEXUSES_LOGO_URL}
  right = the project/client logo (use the project's logo URL when known). If the client logo is missing, ASK the user for the client logo URL (e.g. SMI logo) before finalizing the share — or call share_html and the server will inject logos when available.
- Do NOT put a text-only "NEXUSES" eyebrow as the main brand — use the logo image.
- Title under the header should use Plus Jakarta Sans, bold, normal tracking (not ultra-condensed / ultra-wide).
- Layout: header logos → title + short subtitle → KPI stat cards → chart and/or real HTML <table> (never markdown pipe tables inside HTML).
- Make rows scannable; use rounded-3xl cards, soft shadow, generous padding. Mobile-friendly.
- Prefer semantic HTML + Tailwind utility classes. No React. Inline a small <script> only for Chart.js.`;
