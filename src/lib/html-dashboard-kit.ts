const KIT_MARK = "data-nexuses-kit";

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
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #f6f3ee; color: #1c1916; font-family: "DM Sans", ui-sans-serif, system-ui, sans-serif; }
  body { background-image: radial-gradient(circle at top left, rgba(30,138,122,0.10), transparent 42%), linear-gradient(180deg, #f6f3ee 0%, #efeae2 100%); }
  h1, h2, h3, .font-display { font-family: Outfit, ui-sans-serif, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.025em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.85rem 1rem; border-bottom: 1px solid #ddd6cb; vertical-align: top; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b6560; font-weight: 600; }
  tbody tr:hover { background: rgba(30,138,122,0.04); }
  .nx-shell { max-width: 1120px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .nx-card { background: rgba(255,255,255,0.72); border: 1px solid #ddd6cb; border-radius: 1.5rem; box-shadow: 0 18px 50px rgba(28,25,22,0.08); backdrop-filter: blur(8px); }
  .nx-stat { padding: 1.25rem 1.35rem; }
  .nx-stat .label { font-size: 0.75rem; color: #6b6560; text-transform: uppercase; letter-spacing: 0.06em; }
  .nx-stat .value { margin-top: 0.35rem; font-family: Outfit, sans-serif; font-size: 1.85rem; font-weight: 600; letter-spacing: -0.025em; }
  .nx-brand { color: #1e8a7a; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.72rem; }
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

function looksStyled(html: string) {
  return (
    html.includes(KIT_MARK) ||
    /cdn\.tailwindcss\.com/i.test(html) ||
    /tailwindcss/i.test(html) ||
    (/stylesheet/i.test(html) && /class=["'][^"']{20,}/i.test(html))
  );
}

/**
 * Ensure shared HTML dashboards get Tailwind + Nexuses fonts/colors + Chart.js.
 * Converts leaked markdown tables into real HTML tables.
 */
export function enhanceSharedHtml(raw: string, titleHint?: string) {
  let html = raw.trim();
  if (!html) return html;

  html = markdownTablesToHtml(html);
  // Upgrade older shares that still hardcode Syne headings.
  html = html
    .replace(/family=Syne:[^"'&\s]+/g, "family=Outfit:wght@500;600;700")
    .replace(/"Syne"/g, '"Outfit"')
    .replace(/'Syne'/g, "'Outfit'")
    .replace(/font-family:\s*Syne/gi, "font-family: Outfit")
    .replace(/\bSyne\b/g, "Outfit");

  const title = titleHint || extractTitle(html);

  if (looksStyled(html) && /<html[\s>]/i.test(html)) {
    if (!html.includes(KIT_MARK)) {
      return html.replace(/<html/i, `<html ${KIT_MARK}`);
    }
    return html;
  }

  const body = stripDocumentChrome(html);
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
  <p class="nx-brand">Nexuses</p>
  ${body}
</main>
</body>
</html>`;
}

export const HTML_DASHBOARD_PROMPT = `When creating HTML dashboards / reports / shareable pages:
- Output a COMPLETE HTML document in an \`\`\`html fence (DOCTYPE, html, head, body).
- Use Tailwind via CDN (cdn.tailwindcss.com) plus Chart.js (cdn.jsdelivr.net/npm/chart.js) when charts help.
- Fonts: Outfit for headings, DM Sans for body (Google Fonts).
- Palette: background #f6f3ee, text #1c1916, accent #1e8a7a, borders #ddd6cb. Avoid purple gradients, neon glow, and emoji decoration.
- Brand: show "Nexuses" as a small uppercase accent label near the top — do not overpower it with a giant unrelated headline.
- Layout: one clear hero title + short subtitle, then a row of KPI stat cards, then one chart and/or one real HTML <table> (never markdown pipe tables inside HTML).
- Make rows scannable; use rounded-3xl cards, soft shadow, generous padding. Mobile-friendly.
- Prefer semantic HTML + Tailwind utility classes. No React. Inline a small <script> only for Chart.js.`;
