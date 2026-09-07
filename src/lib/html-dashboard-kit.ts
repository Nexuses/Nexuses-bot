export const NEXUSES_LOGO_URL =
  "https://cdn-nexlink.s3.us-east-2.amazonaws.com/Nexuses-full-logo-dark_8d412ea3-bf11-4fc6-af9c-bee7e51ef494.png";

const KIT_MARK = "data-nexuses-kit";
const HEADER_MARK = "data-nexuses-report-header";
const SHELL_MARK = "data-nexuses-shell";

export type ShareEnhanceOptions = {
  titleHint?: string;
  clientLogoUrl?: string;
  clientName?: string;
};

const SIDE_PAD = "max(1.75rem, 6vw)";

const KIT_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet" />
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
          display: ["Outfit", "ui-sans-serif", "system-ui", "sans-serif"],
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
<style data-nexuses-kit-css>
  :root { color-scheme: light; }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    min-height: 100%;
    background: #f6f3ee;
    color: #1c1916;
    font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif;
  }
  body {
    background-image:
      radial-gradient(circle at top left, rgba(30,138,122,0.10), transparent 42%),
      linear-gradient(180deg, #f6f3ee 0%, #efeae2 100%);
  }
  h1, h2, h3, .font-display {
    font-family: "Outfit", ui-sans-serif, system-ui, sans-serif !important;
    letter-spacing: -0.02em;
    font-weight: 700;
  }
  h1 { font-size: clamp(1.75rem, 3vw, 2.35rem); line-height: 1.15; max-width: 22ch; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.85rem 1rem; border-bottom: 1px solid #ddd6cb; vertical-align: top; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b6560; font-weight: 600; }
  tbody tr:hover { background: rgba(30,138,122,0.04); }

  /* Page gutters — always applied, even when the model used px-0 / w-screen */
  [${SHELL_MARK}], .nx-shell {
    display: block !important;
    width: 100% !important;
    max-width: 1080px !important;
    margin: 0 auto !important;
    padding: 2rem ${SIDE_PAD} 4rem !important;
    box-sizing: border-box !important;
  }
  [${SHELL_MARK}] .w-screen,
  [${SHELL_MARK}] .max-w-none,
  [${SHELL_MARK}] .max-w-full {
    max-width: 100% !important;
    width: 100% !important;
  }
  [${SHELL_MARK}] .px-0,
  [${SHELL_MARK}] .pl-0,
  [${SHELL_MARK}] .pr-0 {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }

  .nx-card {
    background: rgba(255,255,255,0.72);
    border: 1px solid #ddd6cb;
    border-radius: 1.5rem;
    box-shadow: 0 18px 50px rgba(28,25,22,0.08);
    backdrop-filter: blur(8px);
  }
  .nx-stat { padding: 1.25rem 1.35rem; }
  .nx-stat .label { font-size: 0.75rem; color: #6b6560; text-transform: uppercase; letter-spacing: 0.06em; }
  .nx-stat .value {
    margin-top: 0.35rem;
    font-family: "Outfit", sans-serif;
    font-size: 1.85rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .nx-header {
    display: flex !important;
    align-items: center !important;
    justify-content: space-between !important;
    gap: 1rem;
    width: 100%;
    margin: 0 0 1.75rem;
    padding: 0.15rem 0 1.25rem !important;
    border-bottom: 1px solid #ddd6cb;
  }
  .nx-header img { display: block; height: 40px; width: auto; max-width: 180px; object-fit: contain; }
  .nx-header .nx-client-logo { height: 44px; max-width: 160px; }
  .nx-header .nx-client-fallback {
    font-family: "Outfit", sans-serif;
    font-size: 0.85rem;
    font-weight: 700;
    color: #1e8a7a;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid #ddd6cb;
    border-radius: 999px;
    padding: 0.55rem 0.9rem;
    background: rgba(255,255,255,0.7);
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
    ? `<img class="nx-client-logo" src="${escapeAttr(clientLogo)}" alt="${escapeAttr(clientName)}" referrerpolicy="no-referrer" style="display:block;height:44px;width:auto;max-width:160px;object-fit:contain;" />`
    : `<span class="nx-client-fallback">${escapeHtml(clientName)}</span>`;

  return `<header class="nx-header" ${HEADER_MARK} style="display:flex;align-items:center;justify-content:space-between;gap:1rem;width:100%;margin:0 0 1.75rem;padding:0.15rem 0 1.25rem;border-bottom:1px solid #ddd6cb;box-sizing:border-box;">
  <a href="https://nexuses.com" aria-label="Nexuses" style="display:inline-flex;align-items:center;flex:0 0 auto;">
    <img src="${escapeAttr(NEXUSES_LOGO_URL)}" alt="Nexuses" referrerpolicy="no-referrer" style="display:block;height:40px;width:auto;max-width:180px;object-fit:contain;" />
  </a>
  <div style="display:inline-flex;align-items:center;justify-content:flex-end;flex:0 0 auto;margin-left:auto;">
    ${right}
  </div>
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

/** Keep only content from the first H1 onward (drops duplicate logo bars). */
function contentFromTitle(body: string) {
  const h1Index = body.search(/<h1\b/i);
  if (h1Index >= 0) return body.slice(h1Index).trim();
  return body
    .replace(new RegExp(`<header[^>]*${HEADER_MARK}[^>]*>[\\s\\S]*?<\\/header>`, "gi"), "")
    .replace(/<p[^>]*class=["'][^"']*nx-brand[^"']*["'][^>]*>[\s\S]*?<\/p>/gi, "")
    .replace(/<img[^>]*(?:Nexuses-full-logo|cdn-nexlink)[^>]*>/gi, "")
    .trim();
}

/** Unwrap prior shells / full-bleed wrappers so we control gutters. */
function unwrapBodyChrome(body: string) {
  let next = body.trim();
  // Remove previous injected shells.
  next = next.replace(
    new RegExp(`<main[^>]*${SHELL_MARK}[^>]*>([\\s\\S]*?)<\\/main>`, "i"),
    "$1",
  );
  next = next.replace(/<main[^>]*class=["'][^"']*nx-shell[^"']*["'][^>]*>([\s\S]*?)<\/main>/i, "$1");
  // Drop old injected headers — we re-add one.
  next = next.replace(new RegExp(`<header[^>]*${HEADER_MARK}[^>]*>[\\s\\S]*?<\\/header>`, "gi"), "");
  return next.trim();
}

function wrapInShell(inner: string) {
  return `<main class="nx-shell" ${SHELL_MARK} style="display:block;width:100%;max-width:1080px;margin:0 auto;padding:2rem ${SIDE_PAD} 4rem;box-sizing:border-box;">
${inner}
</main>`;
}

function replaceOrInjectHeader(body: string, options?: ShareEnhanceOptions) {
  const cleaned = contentFromTitle(unwrapBodyChrome(body));
  return wrapInShell(`${buildReportHeader(options)}\n${cleaned}`);
}

function ensureKitInHead(doc: string) {
  let next = doc.replace(/<style[^>]*data-nexuses-kit-css[^>]*>[\s\S]*?<\/style>/gi, "");
  if (/<\/head>/i.test(next)) {
    return next.replace(/<\/head>/i, `${KIT_HEAD}\n</head>`);
  }
  return next;
}

/**
 * Ensure shared HTML dashboards get Tailwind + Nexuses fonts/colors + Chart.js.
 * Always wraps content in a padded shell so left/right margins are never 0.
 */
export function enhanceSharedHtml(raw: string, options?: ShareEnhanceOptions | string) {
  const opts: ShareEnhanceOptions =
    typeof options === "string" ? { titleHint: options } : options || {};

  let html = raw.trim();
  if (!html) return html;

  html = markdownTablesToHtml(html);
  const title = opts.titleHint || extractTitle(html);
  const shellBody = replaceOrInjectHeader(
    looksStyled(html) && /<body[\s>]/i.test(html) ? stripDocumentChrome(html) : stripDocumentChrome(html),
    opts,
  );

  // Always rebuild a consistent document so gutters cannot be overridden by the model.
  if (looksStyled(html) && /<html[\s>]/i.test(html)) {
    let doc = html.includes(KIT_MARK) ? html : html.replace(/<html/i, `<html ${KIT_MARK}`);
    doc = doc
      .replace(/family=Syne[^"&]*/gi, "family=Outfit:wght@500;600;700")
      .replace(/["']Syne["']/g, '"Outfit"')
      .replace(/font-family:\s*Syne/gi, 'font-family: "Outfit"');
    if (!/Outfit/i.test(doc)) {
      doc = doc.replace(
        /<\/head>/i,
        `<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&display=swap" rel="stylesheet" />\n</head>`,
      );
    }
    doc = ensureKitInHead(doc);
    if (/<body[^>]*>[\s\S]*<\/body>/i.test(doc)) {
      doc = doc.replace(/<body[^>]*>[\s\S]*<\/body>/i, `<body style="margin:0;padding:0;">${shellBody}</body>`);
    } else {
      doc += `<body style="margin:0;padding:0;">${shellBody}</body>`;
    }
    return doc;
  }

  return `<!DOCTYPE html>
<html lang="en" ${KIT_MARK}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
${KIT_HEAD}
</head>
<body style="margin:0;padding:0;">
${shellBody}
</body>
</html>`;
}

export const HTML_DASHBOARD_PROMPT = `When creating HTML dashboards / reports / shareable pages:
- Output a COMPLETE HTML document in an \`\`\`html fence (DOCTYPE, html, head, body).
- Use Tailwind via CDN (cdn.tailwindcss.com) plus Chart.js (cdn.jsdelivr.net/npm/chart.js) when charts help.
- Fonts: Outfit for headings (NOT Syne / ultra-wide fonts), DM Sans for body (Google Fonts).
- Palette: background #f6f3ee, text #1c1916, accent #1e8a7a, borders #ddd6cb. Avoid purple gradients, neon glow, and emoji decoration.
- Header (required): left = Nexuses logo, right = client/project logo ONCE in that header only. Do NOT repeat the client logo or client name above the title.
- Do NOT put a text-only "NEXUSES" eyebrow as the main brand — use the logo image.
- Title under the header should use Outfit, bold, normal tracking (not ultra-condensed / ultra-wide).
- Layout: wrap ALL page content in a centered container with left/right padding of at least 24px / 6vw (never px-0 or full-bleed edge-to-edge content). Structure: header → title + subtitle → KPI cards → chart/table.
- Make rows scannable; use rounded-3xl cards, soft shadow, generous padding. Mobile-friendly.
- Prefer semantic HTML + Tailwind utility classes. No React. Inline a small <script> only for Chart.js.`;
