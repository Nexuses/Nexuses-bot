import { NEXUSES_LOGO_URL } from "@/lib/brand";

export type OutreachLead = {
  campaign: string;
  name: string;
  email: string;
  stage: "Replied" | "Clicked" | "Open" | "Sent" | "Bounced";
  opened: boolean;
  clicked: boolean;
  replied: boolean;
};

export type OutreachCampaignBundle = {
  campaign: string;
  rows: Record<string, string>[];
};

const KIT_MARK = "data-nexuses-kit";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cell(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const match = Object.keys(row).find(
      (header) =>
        header === key ||
        header.replace(/[_\s]+/g, "") === key.replace(/[_\s]+/g, ""),
    );
    if (match && row[match]) return row[match];
  }
  return "";
}

function hasEngagementValue(value: string) {
  const v = value.trim();
  if (!v) return false;
  if (/^(0|false|no|n\/a|na|-)$/i.test(v)) return false;
  return true;
}

function rowOpened(row: Record<string, string>) {
  return (
    hasEngagementValue(cell(row, ["opened time", "opened_time", "open time", "opened"])) ||
    Number(cell(row, ["open count", "open_count", "opens"]) || 0) > 0
  );
}

function rowClicked(row: Record<string, string>) {
  return (
    hasEngagementValue(cell(row, ["clicked time", "clicked_time", "click time", "clicked"])) ||
    Number(cell(row, ["click count", "click_count", "clicks"]) || 0) > 0
  );
}

function rowReplied(row: Record<string, string>) {
  return (
    hasEngagementValue(cell(row, ["replied time", "replied_time", "reply time", "replied"])) ||
    hasEngagementValue(cell(row, ["reply message", "reply_message", "reply"]))
  );
}

function rowBounced(row: Record<string, string>) {
  const bounce = cell(row, ["bounce", "bounced", "status", "delivery status", "delivery_status"]);
  if (/bounce/i.test(bounce)) return true;
  const reply = cell(row, ["reply message", "reply_message", "reply"]);
  return /bounce|undeliver/i.test(reply);
}

function engagementScore(row: Record<string, string>) {
  if (rowReplied(row)) return 4;
  if (rowClicked(row)) return 3;
  if (rowOpened(row)) return 2;
  if (hasEngagementValue(cell(row, ["sent time", "sent_time", "sent"]))) return 1;
  return 0;
}

/** Turn "Investera_Camp General _  Zoya Report.csv" → "Camp General Zoya". */
export function campaignNameFromFile(fileName: string) {
  let name = fileName.replace(/\.[^.]+$/, "");
  name = name.replace(/^investera[_\s-]*/i, "");
  name = name.replace(/[_\s-]*report$/i, "");
  name = name.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/\s+-\s+/g, " ").trim();
  return name || fileName;
}

export function looksLikeOutreachEngagementCsv(rows: Record<string, string>[]) {
  const sample = rows[0] || {};
  const keys = Object.keys(sample).join(" ");
  return /lead\s*email|lead\s*name|opened\s*time|clicked\s*time|open\s*count|click\s*count|sent\s*time/i.test(
    keys,
  );
}

/** Deduplicate by email within a campaign, keeping the highest-engagement sequence row. */
export function buildOutreachLeads(bundles: OutreachCampaignBundle[]): OutreachLead[] {
  const leads: OutreachLead[] = [];
  for (const bundle of bundles) {
    const byEmail = new Map<
      string,
      { lead: OutreachLead; score: number }
    >();
    for (const row of bundle.rows) {
      const emailRaw = cell(row, ["lead email", "lead_email", "email", "email address"]);
      const email = emailRaw.trim();
      if (!email || !email.includes("@")) continue;
      const opened = rowOpened(row);
      const clicked = rowClicked(row);
      const replied = rowReplied(row);
      const bounced = rowBounced(row) && !opened && !clicked && !replied;
      let stage: OutreachLead["stage"] = "Sent";
      if (bounced) stage = "Bounced";
      else if (replied) stage = "Replied";
      else if (clicked) stage = "Clicked";
      else if (opened) stage = "Open";
      const name =
        cell(row, ["lead name", "lead_name", "name", "full name", "full_name"]) ||
        email.split("@")[0];
      const score = engagementScore(row) + (bounced ? 0.5 : 0);
      const key = email.toLowerCase();
      const next: OutreachLead = {
        campaign: bundle.campaign,
        name,
        email,
        stage,
        opened,
        clicked,
        replied,
      };
      const prev = byEmail.get(key);
      if (!prev || score > prev.score) {
        byEmail.set(key, { lead: next, score });
      }
    }
    for (const entry of byEmail.values()) {
      leads.push(entry.lead);
    }
  }
  return leads;
}

function badgeClass(stage: OutreachLead["stage"]) {
  switch (stage) {
    case "Clicked":
      return "b-click";
    case "Open":
      return "b-open";
    case "Replied":
      return "b-replied";
    case "Bounced":
      return "b-bounced";
    default:
      return "b-sent";
  }
}

export function renderOutreachCampaignReport(input: {
  title: string;
  subtitle?: string;
  leads: OutreachLead[];
  clientLogoUrl?: string;
  clientName?: string;
}) {
  const title = (input.title || "Outreach Report").trim() || "Outreach Report";
  const leads = input.leads;
  const campaigns = [...new Set(leads.map((lead) => lead.campaign))];
  const total = leads.length;
  const opened = leads.filter((lead) => lead.opened).length;
  const clicked = leads.filter((lead) => lead.clicked).length;
  const replied = leads.filter((lead) => lead.replied).length;

  const perCampaign = campaigns.map((campaign) => {
    const subset = leads.filter((lead) => lead.campaign === campaign);
    return {
      campaign,
      total: subset.length,
      opened: subset.filter((lead) => lead.opened).length,
      clicked: subset.filter((lead) => lead.clicked).length,
      replied: subset.filter((lead) => lead.replied).length,
    };
  });

  const subtitle =
    (input.subtitle || "").trim() ||
    (campaigns.length
      ? campaigns.join(" · ")
      : "Every lead with sent / open / click detail");

  const clientLogo = (input.clientLogoUrl || "").trim();
  const clientName = (input.clientName || "").trim();

  const tabs = [
    `<button type="button" class="tab active" data-camp="all">All (${total})</button>`,
    ...perCampaign.map(
      (item) =>
        `<button type="button" class="tab" data-camp="${escapeHtml(item.campaign)}">${escapeHtml(item.campaign)} (${item.total})</button>`,
    ),
  ].join("\n      ");

  const rowsHtml = leads
    .map((lead) => {
      return `<tr data-camp="${escapeHtml(lead.campaign)}" data-search="${escapeHtml(`${lead.name} ${lead.email}`.toLowerCase())}"><td>${escapeHtml(lead.campaign)}</td><td><strong>${escapeHtml(lead.name)}</strong></td><td>${escapeHtml(lead.email)}</td><td><span class="badge ${badgeClass(lead.stage)}">${escapeHtml(lead.stage)}</span></td><td>${lead.opened ? "Yes" : "No"}</td><td>${lead.clicked ? "Yes" : "No"}</td></tr>`;
    })
    .join("");

  const chartLabels = JSON.stringify(perCampaign.map((item) => item.campaign));
  const chartOpened = JSON.stringify(perCampaign.map((item) => item.opened));
  const chartClicked = JSON.stringify(perCampaign.map((item) => item.clicked));

  return `<!DOCTYPE html>
<html lang="en" ${KIT_MARK}>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&display=swap" rel="stylesheet" />
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  body{font-family:'Roboto',sans-serif;background:#f6f3ee;color:#1c1916;margin:0;}
  .wrap{max-width:1200px;margin:0 auto;padding:24px;}
  .card{background:#fff;border:1px solid #ddd6cb;border-radius:14px;padding:20px;}
  .kpi{background:#fff;border:1px solid #ddd6cb;border-radius:14px;padding:20px;text-align:center;}
  .kpi .num{font-size:34px;font-weight:900;color:#1e8a7a;}
  .kpi .lab{font-size:13px;color:#6b645c;text-transform:uppercase;letter-spacing:.5px;margin-top:4px;}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{background:#1e8a7a;color:#fff;text-align:left;padding:10px 12px;font-weight:700;position:sticky;top:0;}
  td{padding:9px 12px;border-bottom:1px solid #eee7dc;}
  tr:nth-child(even){background:#faf7f2;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;}
  .b-sent{background:#eee7dc;color:#6b645c;}
  .b-open{background:#e3f2ef;color:#1e8a7a;}
  .b-click{background:#dcefea;color:#0f6b5e;}
  .b-replied{background:#fdeee0;color:#b45309;}
  .b-bounced{background:#fbe4e4;color:#b91c1c;}
  .tab{display:inline-block;padding:8px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px;border:1px solid #ddd6cb;background:#fff;margin-right:6px;margin-bottom:6px;}
  .tab.active{background:#1e8a7a;color:#fff;border-color:#1e8a7a;}
  .search{width:100%;padding:10px 14px;border:1px solid #ddd6cb;border-radius:8px;font-family:'Roboto';font-size:14px;box-sizing:border-box;}
  .scroll{max-height:560px;overflow:auto;border-radius:10px;border:1px solid #ddd6cb;}
  .chartbox{height:280px;}
</style>
</head>
<body>
<div class="wrap">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;gap:16px;flex-wrap:wrap;">
    <img src="${NEXUSES_LOGO_URL}" alt="Nexuses" style="height:34px;width:auto;" />
    ${
      clientLogo
        ? `<img src="${escapeHtml(clientLogo)}" alt="${escapeHtml(clientName || "Client")}" style="height:34px;width:auto;max-width:180px;object-fit:contain;" />`
        : clientName
          ? `<span style="font-weight:700;color:#1e8a7a;">${escapeHtml(clientName)}</span>`
          : ""
    }
  </div>
  <h1 style="font-size:28px;font-weight:900;margin:0 0 4px;">${escapeHtml(title)}</h1>
  <p style="color:#6b645c;margin:0 0 20px;font-size:14px;">${escapeHtml(subtitle)}</p>

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px;">
    <div class="kpi"><div class="num">${total.toLocaleString()}</div><div class="lab">Total Leads</div></div>
    <div class="kpi"><div class="num">${opened.toLocaleString()}</div><div class="lab">Open</div></div>
    <div class="kpi"><div class="num">${clicked.toLocaleString()}</div><div class="lab">Clicks</div></div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px;">
    <div class="card"><div class="chartbox"><canvas id="barChart"></canvas></div></div>
    <div class="card"><div class="chartbox"><canvas id="pieChart"></canvas></div></div>
  </div>

  <div class="card" style="margin-bottom:14px;">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-bottom:12px;">
      ${tabs}
    </div>
    <input type="text" class="search" id="search" placeholder="Search by name or email…" />
  </div>

  <div class="card">
    <div class="scroll">
      <table id="leadTable">
        <thead><tr><th>Campaign</th><th>Lead Name</th><th>Email</th><th>Stage</th><th>Opened</th><th>Clicked</th></tr></thead>
        <tbody id="tbody">${rowsHtml}</tbody>
      </table>
    </div>
    <p style="margin:12px 0 0;font-size:12px;color:#6b645c;">${total.toLocaleString()} unique leads · ${opened.toLocaleString()} opened · ${clicked.toLocaleString()} clicked${replied ? ` · ${replied.toLocaleString()} replied` : ""}</p>
  </div>
</div>
<script>
(() => {
  let activeCamp = "all";
  const search = document.getElementById("search");
  function doSearch() {
    const q = (search && search.value ? search.value : "").toLowerCase().trim();
    document.querySelectorAll("#tbody tr").forEach((tr) => {
      const camp = tr.getAttribute("data-camp") || "";
      const hay = tr.getAttribute("data-search") || "";
      const campOk = activeCamp === "all" || camp === activeCamp;
      const searchOk = !q || hay.includes(q);
      tr.style.display = campOk && searchOk ? "" : "none";
    });
  }
  document.querySelectorAll(".tab").forEach((el) => {
    el.addEventListener("click", () => {
      activeCamp = el.getAttribute("data-camp") || "all";
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.toggle("active", tab === el);
      });
      doSearch();
    });
  });
  if (search) search.addEventListener("input", doSearch);

  if (typeof Chart === "undefined") return;
  const labels = ${chartLabels};
  const openedData = ${chartOpened};
  const clickedData = ${chartClicked};
  const bar = document.getElementById("barChart");
  const pie = document.getElementById("pieChart");
  if (bar) {
    new Chart(bar, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Opened", data: openedData, backgroundColor: "#1e8a7a" },
          { label: "Clicked", data: clickedData, backgroundColor: "#0f6b5e" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }
  if (pie) {
    new Chart(pie, {
      type: "doughnut",
      data: {
        labels: ["Opened", "Clicked", "Sent only"],
        datasets: [{
          data: [${opened}, ${clicked}, ${Math.max(0, total - opened)}],
          backgroundColor: ["#1e8a7a", "#0f6b5e", "#eee7dc"],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
      },
    });
  }
})();
</script>
</body>
</html>`;
}
