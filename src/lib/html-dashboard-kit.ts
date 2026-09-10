import { NEXUSES_LOGO_URL } from "@/lib/brand";

const KIT_MARK = "data-nexuses-kit";

export { NEXUSES_LOGO_URL };

/** Kept for callers; initial design does not inject logo headers. */
export type ShareEnhanceOptions = {
  titleHint?: string;
  clientLogoUrl?: string;
  clientName?: string;
};

const KIT_HEAD = `
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Syne:wght@600;700;800&display=swap" rel="stylesheet" />
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
          display: ["Syne", "ui-sans-serif", "system-ui", "sans-serif"],
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
  h1, h2, h3, .font-display { font-family: Syne, ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.03em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.85rem 1rem; border-bottom: 1px solid #ddd6cb; vertical-align: top; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6b6560; font-weight: 600; }
  tbody tr:hover { background: rgba(30,138,122,0.04); }
  .nx-shell { max-width: 1120px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  .nx-card { background: rgba(255,255,255,0.72); border: 1px solid #ddd6cb; border-radius: 1.5rem; box-shadow: 0 18px 50px rgba(28,25,22,0.08); backdrop-filter: blur(8px); }
  .nx-stat { padding: 1.25rem 1.35rem; }
  .nx-stat .label { font-size: 0.75rem; color: #6b6560; text-transform: uppercase; letter-spacing: 0.06em; }
  .nx-stat .value { margin-top: 0.35rem; font-family: Syne, sans-serif; font-size: 1.85rem; font-weight: 700; letter-spacing: -0.03em; }
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

export type DataDashboardInput = {
  title: string;
  subtitle?: string;
  kpis?: { label: string; value: string }[];
  columns: string[];
  rows: Array<Array<string | number | null | undefined>>;
  chart?: {
    type?: "bar" | "doughnut";
    labels: string[];
    values: number[];
    title?: string;
  };
  clientLogoUrl?: string;
  clientName?: string;
};

/** Server-built dashboard HTML so the model never has to emit huge table markup. */
export function renderDataDashboard(input: DataDashboardInput) {
  const title = (input.title || "Dashboard").trim() || "Dashboard";
  const subtitle = (input.subtitle || "").trim();
  const columns = (input.columns || []).map((c) => String(c || "").trim()).filter(Boolean);
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!columns.length) throw new Error("columns are required");
  if (rows.length > 5000) throw new Error("Too many rows (max 5000)");

  const kpis = (input.kpis || [])
    .slice(0, 8)
    .map((k) => ({
      label: String(k.label || "").trim(),
      value: String(k.value ?? "").trim(),
    }))
    .filter((k) => k.label);

  const clientLogo = (input.clientLogoUrl || "").trim();
  const chart = input.chart;
  const chartId = `nxChart_${Math.random().toString(36).slice(2, 9)}`;
  const chartType = chart?.type === "doughnut" ? "doughnut" : "bar";

  const kpiHtml = kpis.length
    ? `<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">${kpis
        .map(
          (k) =>
            `<div class="nx-card nx-stat"><div class="label">${escapeHtml(k.label)}</div><div class="value">${escapeHtml(k.value)}</div></div>`,
        )
        .join("")}</div>`
    : "";

  const chartHtml =
    chart && chart.labels?.length && chart.values?.length
      ? `<div class="nx-card p-6 mb-8">
  ${chart.title ? `<h2 class="font-display text-xl mb-4">${escapeHtml(chart.title)}</h2>` : ""}
  <canvas id="${chartId}" height="120"></canvas>
</div>
<script>
(() => {
  const el = document.getElementById("${chartId}");
  if (!el || typeof Chart === "undefined") return;
  new Chart(el, {
    type: "${chartType}",
    data: {
      labels: ${JSON.stringify(chart.labels.map(String))},
      datasets: [{
        data: ${JSON.stringify(chart.values.map(Number))},
        backgroundColor: ["#1e8a7a","#176f62","#4aa897","#8bbfb4","#c5ddd7","#efeae2"],
        borderWidth: 0
      }]
    },
    options: {
      plugins: { legend: { display: ${chartType === "doughnut" ? "true" : "false"} } },
      scales: ${chartType === "bar" ? "{ y: { beginAtZero: true } }" : "undefined"}
    }
  });
})();
</script>`
      : "";

  const headCells = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const bodyRows = rows
    .map((row) => {
      const cells = columns
        .map((_, i) => {
          const raw = Array.isArray(row) ? row[i] : "";
          return `<td>${escapeHtml(raw == null ? "" : String(raw))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");

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
  <header class="flex items-center justify-between gap-4 mb-8">
    <img src="${NEXUSES_LOGO_URL}" alt="Nexuses" style="height:36px;width:auto;" />
    ${
      clientLogo
        ? `<img src="${escapeHtml(clientLogo)}" alt="${escapeHtml(input.clientName || "Client")}" style="height:36px;width:auto;max-width:160px;object-fit:contain;" />`
        : input.clientName
          ? `<span class="text-sm text-muted">${escapeHtml(input.clientName)}</span>`
          : ""
    }
  </header>
  <h1 class="font-display text-4xl mb-2">${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="text-muted mb-8">${escapeHtml(subtitle)}</p>` : `<div class="mb-8"></div>`}
  ${kpiHtml}
  ${chartHtml}
  <div class="nx-card overflow-x-auto">
    <table>
      <thead><tr>${headCells}</tr></thead>
      <tbody>
${bodyRows}
      </tbody>
    </table>
  </div>
  <p class="mt-4 text-xs text-muted">${rows.length} row${rows.length === 1 ? "" : "s"}</p>
</main>
</body>
</html>`;
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
export function enhanceSharedHtml(raw: string, options?: ShareEnhanceOptions | string) {
  const titleHint =
    typeof options === "string" ? options : options?.titleHint;

  let html = raw.trim();
  if (!html) return html;

  html = markdownTablesToHtml(html);
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
  <p class="nx-brand"><img src="${NEXUSES_LOGO_URL}" alt="Nexuses" style="height:28px;width:auto;display:block;" /></p>
  ${body}
</main>
</body>
</html>`;
}

export const HTML_DASHBOARD_PROMPT = `When creating HTML dashboards / reports / shareable pages:
- Prefer share_csv_dashboard when a CSV file is attached (server reads the full file — do not pass rows). Prefer share_data_dashboard for campaign/lead reports when you already have structured JSON (pass title, kpis, columns, rows). The server builds the full HTML — do NOT emit hundreds of table rows yourself.
- For custom one-off HTML that is SMALL (roughly under ~40 table rows or a short page): call share_html once with the full HTML, and optionally also show a short \`\`\`html preview fence.
- For LARGE custom HTML (long tables, multi-section reports): NEVER put the full document in one share_html call or one fence (it truncates and breaks JSON). Instead:
  1) share_html_begin
  2) share_html_append repeatedly with chunks ≤12000 characters (send several appends per turn)
  3) share_html_finish — then paste ONLY the returned url
- Use Tailwind via CDN (cdn.tailwindcss.com) plus Chart.js when charts help (share_data_dashboard already includes both).
- Fonts: Syne for headings, DM Sans for body (Google Fonts).
- Palette: background #f6f3ee, text #1c1916, accent #1e8a7a, borders #ddd6cb. Avoid purple gradients, neon glow, and emoji decoration.
- Brand: use the Nexuses logo image (NOT text-only "NEXUSES") at the top-left of the header:
  ${NEXUSES_LOGO_URL}
  Example: <img src="${NEXUSES_LOGO_URL}" alt="Nexuses" style="height:36px;width:auto;" />
  Put the project/client logo on the right when available. Do not invent another Nexuses logo URL.
- Layout: one clear hero title + short subtitle, then a row of KPI stat cards, then one chart and/or one real HTML <table> (never markdown pipe tables inside HTML).
- Prefer semantic HTML + Tailwind utility classes. No React. Inline a small <script> only for Chart.js.
- Never invent /p/... URLs. Never claim a size limit forces splitting into multiple dashboards when share_csv_dashboard, share_data_dashboard, or chunked share_html_* can publish one page.`;
