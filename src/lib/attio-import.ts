const ATTIO = "https://api.attio.com";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url: string, init: RequestInit, retries = 7) {
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(url, { ...init, cache: "no-store" });
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      lastError = `${res.status} ${res.statusText}: ${text.slice(0, 400)}`;
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN;
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(60_000, retryAfterSec * 1000)
        : Math.min(45_000, 1500 * 2 ** attempt);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
    }
    if (!text) return "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error(lastError || "Attio rate limit exceeded after retries");
}

function attioHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

function pickAttioId(data: unknown, keys: string[]) {
  const record = data as {
    data?: { id?: Record<string, string>; api_slug?: string };
  };
  const id = record?.data?.id;
  if (id) {
    for (const key of keys) {
      if (id[key]) return id[key];
    }
  }
  return record?.data?.api_slug || "";
}

function splitCsvTable(text: string) {
  const input = text.replace(/^\uFEFF/, "");
  const table: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const pushRow = () => {
    if (row.some((value) => value.length > 0)) table.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "," || char === "\t") {
      pushCell();
      continue;
    }
    if (char === "\n") {
      pushCell();
      pushRow();
      continue;
    }
    if (char === "\r") continue;
    cell += char;
  }
  pushCell();
  pushRow();
  return table;
}

function isEmailHeaderRow(cols: string[]) {
  const labels = cols.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (labels.length < 2) return false;
  return labels.some(
    (h) =>
      h === "email" ||
      h === "email address" ||
      h === "e-mail" ||
      h === "email_address" ||
      h === "work email" ||
      h === "lead email",
  );
}

function engagementSectionFromRow(cols: string[]) {
  if (isEmailHeaderRow(cols)) return "";
  const text = cols.join(" ").trim().toLowerCase();
  if (!text) return "";
  // Order matters: "opens only … no click" must not match the clicker rule.
  if (/opens?\s*only|opened email.*no click|no click/i.test(text)) return "opened";
  if (/clicker|clicked a link|opened\s*&\s*clicked/i.test(text)) return "clicked";
  if (/^sent\b|all emails delivered|emails delivered/i.test(text)) return "sent";
  return "";
}

function applySectionEngagement(record: Record<string, string>, section: string) {
  if (section === "clicked") {
    record.clicked = record.clicked || "1";
    record.opened = record.opened || "1";
    record.sent = record.sent || "1";
    record["click count"] = record["click count"] || "1";
    record["open count"] = record["open count"] || "1";
  } else if (section === "opened") {
    record.opened = record.opened || "1";
    record.sent = record.sent || "1";
    record["open count"] = record["open count"] || "1";
  } else if (section === "sent") {
    record.sent = record.sent || "1";
  }
  if (section) record._section = section;
}

function cell(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const match = Object.keys(row).find(
      (header) =>
        header === key || header.replace(/[_\s]+/g, "") === key.replace(/[_\s]+/g, ""),
    );
    if (match && row[match]) return row[match];
  }
  return "";
}

function emailFromRecord(row: Record<string, string>) {
  return cell(row, [
    "email",
    "email address",
    "e-mail",
    "work email",
    "email_address",
    "lead email",
    "lead_email",
  ])
    .trim()
    .toLowerCase();
}

const ENGAGEMENT_RANK: Record<string, number> = {
  clicked: 3,
  opened: 2,
  sent: 1,
};

function sectionRank(row: Record<string, string>) {
  const section = String(row._section || "").toLowerCase();
  if (section && ENGAGEMENT_RANK[section]) return ENGAGEMENT_RANK[section];
  if (rowMatchesCsvFilter(row, "clicked")) return 3;
  if (rowMatchesCsvFilter(row, "opened")) return 2;
  if (rowMatchesCsvFilter(row, "sent")) return 1;
  return 0;
}

/** Keep highest engagement when the same email appears in Sent + Opens + Clicks sections. */
function dedupeEngagementRows(rows: Record<string, string>[]) {
  const byEmail = new Map<string, Record<string, string>>();
  const withoutEmail: Record<string, string>[] = [];
  for (const row of rows) {
    const email = emailFromRecord(row);
    if (!email || !email.includes("@")) {
      withoutEmail.push(row);
      continue;
    }
    const existing = byEmail.get(email);
    if (!existing || sectionRank(row) > sectionRank(existing)) {
      byEmail.set(email, { ...row });
    } else if (existing && sectionRank(row) === sectionRank(existing)) {
      // Fill blank fields from the duplicate row.
      for (const [key, value] of Object.entries(row)) {
        if (value && !existing[key]) existing[key] = value;
      }
    }
  }
  return [...byEmail.values(), ...withoutEmail];
}

export function parseCsv(text: string) {
  const table = splitCsvTable(text);
  if (!table.length) return [] as Record<string, string>[];

  let headers: string[] | null = null;
  let section = "";
  const rows: Record<string, string>[] = [];

  for (const cols of table) {
    const sectionHit = engagementSectionFromRow(cols);
    if (sectionHit) {
      section = sectionHit;
      continue;
    }
    if (isEmailHeaderRow(cols)) {
      headers = cols.map((header) => header.trim().toLowerCase());
      continue;
    }
    if (!headers) continue;

    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = (cols[index] || "").trim().replace(/^"|"$/g, "");
    });
    // Skip banner/summary leftovers that somehow share the header shape.
    const email = emailFromRecord(record);
    if (!email.includes("@") && !cell(record, ["person name", "name", "full name"])) continue;

    applySectionEngagement(record, section);
    rows.push(record);
  }

  // Classic flat CSV: first row is the header when no email header was found mid-file.
  if (!rows.length && table.length >= 2 && !headers) {
    const fallbackHeaders = table[0].map((header) => header.trim().toLowerCase());
    if (isEmailHeaderRow(table[0]) || fallbackHeaders.some((h) => h.includes("email"))) {
      for (const cols of table.slice(1)) {
        const record: Record<string, string> = {};
        fallbackHeaders.forEach((header, index) => {
          if (header) record[header] = (cols[index] || "").trim().replace(/^"|"$/g, "");
        });
        rows.push(record);
      }
    }
  }

  const hasSections = rows.some((row) => Boolean(row._section));
  return hasSections ? dedupeEngagementRows(rows) : rows;
}

function parseName(row: Record<string, string>) {
  const full = cell(row, [
    "person name",
    "name",
    "full name",
    "full_name",
    "contact",
    "lead name",
    "lead_name",
    "contact name",
  ]);
  let first = cell(row, ["first name", "first_name", "firstname", "first"]);
  let last = cell(row, ["last name", "last_name", "lastname", "last", "surname"]);
  if (!first && full) {
    const parts = full.split(/\s+/);
    first = parts[0] || "";
    last = parts.slice(1).join(" ");
  }
  return { first, last, full: full || [first, last].filter(Boolean).join(" ") };
}

function hasEngagementValue(value: string) {
  const v = value.trim();
  if (!v) return false;
  if (/^(0|false|no|n\/a|na|-)$/i.test(v)) return false;
  return true;
}

function rowMatchesCsvFilter(row: Record<string, string>, filter: string) {
  const f = filter.toLowerCase();
  if (!f || f === "all") return true;
  const status = cell(row, ["status", "engagement", "event", "activity", "lead status"]).toLowerCase();
  if (f === "opened" || f === "open") {
    return (
      hasEngagementValue(cell(row, ["opened time", "opened_time", "open time", "opened", "open date"])) ||
      Number(cell(row, ["open count", "open_count", "opens"]) || 0) > 0 ||
      (/open/.test(status) && !/click/.test(status))
    );
  }
  if (f === "clicked" || f === "click") {
    return (
      hasEngagementValue(cell(row, ["clicked time", "clicked_time", "click time", "clicked", "cta clicked"])) ||
      Number(cell(row, ["click count", "click_count", "clicks"]) || 0) > 0 ||
      /click/.test(status)
    );
  }
  if (f === "replied" || f === "reply") {
    return (
      hasEngagementValue(cell(row, ["replied time", "replied_time", "reply time", "replied"])) ||
      hasEngagementValue(cell(row, ["reply message", "reply_message", "reply"])) ||
      /repl/.test(status)
    );
  }
  if (f === "sent") {
    return (
      hasEngagementValue(cell(row, ["sent time", "sent_time", "sent", "send date", "send time", "delivered"])) ||
      hasEngagementValue(cell(row, ["sent email", "sent_email"])) ||
      /sent|deliver|prospect/i.test(status) ||
      // Rows in a delivered export with an email count as sent/prospect candidates.
      Boolean(emailFromRecord(row))
    );
  }
  return true;
}

function engagementStageForRow(
  row: Record<string, string>,
  args: Record<string, unknown>,
  fallbackStage: string,
) {
  const stageReply = String(args.stage_reply || args.stageReply || "hot").trim() || "hot";
  const stageClick =
    String(args.stage_click || args.stageClick || "Clicks").trim() || "Clicks";
  const stageOpen = String(args.stage_open || args.stageOpen || "Open").trim() || "Open";
  const stageSent =
    String(
      args.stage_sent ||
        args.stageSent ||
        args.stage_prospect ||
        args.stageProspect ||
        fallbackStage ||
        "Prospect",
    ).trim() || "Prospect";
  if (rowMatchesCsvFilter(row, "replied")) return stageReply;
  if (rowMatchesCsvFilter(row, "clicked")) return stageClick;
  if (rowMatchesCsvFilter(row, "opened")) return stageOpen;
  if (rowMatchesCsvFilter(row, "sent")) return stageSent;
  return fallbackStage || stageSent || "Prospect";
}

function csvLooksLikeEngagement(rows: Record<string, string>[]) {
  const sample = rows[0] || {};
  const keys = Object.keys(sample).join(" ");
  if (sample._section) return true;
  return /opened|clicked|replied|sent time|send date|open count|click count|opens|clicks|status|_section|delivered|cta clicked/i.test(
    keys,
  );
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index], index);
      }
    },
  );
  await Promise.all(runners);
}

export type AttioImportResult = {
  ok: boolean;
  list: string;
  stage: string | null;
  mapEngagement: boolean;
  imported: number;
  skipped: number;
  byStage: Record<string, number>;
  totalInFile: number;
  importedCap: number;
  truncated: boolean;
  names: string[];
  errors: string[];
};

/** Infer Sent/Open/Click section from common export filenames (same campaign). */
export function engagementSectionFromFileName(name: string) {
  const n = name.toLowerCase();
  if (/click/.test(n)) return "clicked" as const;
  if (/open/.test(n)) return "opened" as const;
  if (/deliver|sent|recipient|all.?lead|prospect/.test(n)) return "sent" as const;
  return "" as const;
}

/**
 * Merge one campaign's delivered / opened / clicked exports (or Excel) into one CSV.
 * Also works with a single all-in-one engagement file (no merge needed).
 * Dedupes later as Click > Open > Prospect.
 */
export function mergeSpreadsheetAttachments(
  files: { name: string; text: string }[],
  inlineCsv = "",
) {
  const sheets = files.filter(
    (file) =>
      /\.(csv|tsv|xlsx|xls|xlsm)$/i.test(file.name) ||
      (file.text.includes(",") &&
        !file.text.startsWith("Large CSV") &&
        !file.text.startsWith("Large Excel")),
  );
  if (!sheets.length) return inlineCsv.trim();

  // Single all-in-one file — use as-is (sections/columns handled by parseCsv).
  if (sheets.length === 1 && !inlineCsv.trim()) {
    return sheets[0].text.trim();
  }

  const ranked = [...sheets].sort((a, b) => {
    const rank = (name: string) => {
      const section = engagementSectionFromFileName(name);
      if (section === "sent") return 1;
      if (section === "opened") return 2;
      if (section === "clicked") return 3;
      return 4;
    };
    return rank(a.name) - rank(b.name);
  });

  const parts: string[] = [];
  for (const file of ranked) {
    const section = engagementSectionFromFileName(file.name);
    if (section === "clicked") parts.push("CLICKERS — Opened & Clicked a Link");
    else if (section === "opened") parts.push("OPENS ONLY — Opened Email, No Click");
    else if (section === "sent") parts.push("SENT — All Emails Delivered");
    parts.push(file.text.trim());
  }
  if (inlineCsv.trim()) parts.push(inlineCsv.trim());
  return parts.join("\n");
}

export async function runAttioCsvImportFromText(input: {
  apiKey: string;
  args: Record<string, unknown>;
  csvText: string;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
  shouldCancel?: () => boolean;
}): Promise<AttioImportResult> {
  const listName = String(input.args.list || input.args.list_name || input.args.listName || "").trim();
  if (!listName) throw new Error("List name is required");
  const stage = String(input.args.stage || input.args.status || "").trim();
  const allRows = parseCsv(input.csvText);
  const maxRows = Math.min(Math.max(Number(input.args.limit) || 2000, 1), 5000);
  const rows = allRows.slice(0, maxRows);
  if (!rows.length) throw new Error("CSV has no data rows. Include a header row and at least one contact.");

  if (allRows.length > maxRows) {
    await input.onStatus?.(
      `CSV has ${allRows.length.toLocaleString()} rows — importing first ${maxRows.toLocaleString()} now…`,
      0,
      maxRows,
    );
  }

  const mapEngagement =
    String(input.args.map_engagement ?? input.args.mapEngagement ?? "").toLowerCase() === "true" ||
    input.args.map_engagement === true ||
    input.args.mapEngagement === true ||
    rows.some((row) => Boolean(row._section)) ||
    (!stage && csvLooksLikeEngagement(rows));

  // If a single stage was passed but rows are multi-section engagement, prefer mapping.
  const forceMapped = rows.some((row) => Boolean(row._section));
  const effectiveMapEngagement = mapEngagement || forceMapped;

  await input.onStatus?.(`Looking up "${listName}" in Attio…`, 0, rows.length);
  const lists = (await requestJson(`${ATTIO}/v2/lists`, {
    headers: attioHeaders(input.apiKey),
  })) as { data?: { name?: string; api_slug?: string; id?: { list_id?: string } }[] };
  const list = (lists.data || []).find(
    (item) =>
      item.name?.toLowerCase() === listName.toLowerCase() ||
      item.api_slug?.toLowerCase() === slugify(listName),
  );
  if (!list) {
    const names = (lists.data || []).map((item) => item.name).filter(Boolean);
    throw new Error(
      `No Attio list named "${listName}". Available lists: ${names.join(", ") || "none"}`,
    );
  }
  const listId = list.id?.list_id || list.api_slug || "";

  const attributes = (await requestJson(
    `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes`,
    { headers: attioHeaders(input.apiKey) },
  )) as { data?: { api_slug?: string; title?: string; type?: string }[] };
  const statusAttr =
    (attributes.data || []).find(
      (item) => item.type === "status" && /stage|status/i.test(item.api_slug || item.title || ""),
    ) || (attributes.data || []).find((item) => item.type === "status");
  const stageSlug = statusAttr?.api_slug || "stage";

  const stagesNeeded = new Set<string>();
  if (effectiveMapEngagement) {
    for (const row of rows) stagesNeeded.add(engagementStageForRow(row, input.args, stage));
  } else if (stage) {
    stagesNeeded.add(stage);
  }

  if (statusAttr) {
    for (const needed of stagesNeeded) {
      if (!needed) continue;
      try {
        await requestJson(
          `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageSlug)}/statuses`,
          {
            method: "POST",
            headers: attioHeaders(input.apiKey),
            body: JSON.stringify({ data: { title: needed } }),
          },
        );
      } catch {
        // Stage already exists.
      }
    }
  }

  const added: string[] = [];
  const failed: string[] = [];
  const byStage: Record<string, number> = {};
  let doneCount = 0;
  const modeNote = effectiveMapEngagement
    ? " with stages from CSV engagement"
    : stage
      ? ` onto "${stage}"`
      : "";
  await input.onStatus?.(
    `Found the list. Importing ${rows.length.toLocaleString()} contact${rows.length === 1 ? "" : "s"}${modeNote} (throttled for Attio)…`,
    0,
    rows.length,
  );

  // Attio rate-limits ~heavily under parallel PUTs — keep concurrency low and retry 429s.
  await mapPool(rows, 2, async (row) => {
    if (input.shouldCancel?.()) {
      throw new Error("Stopped by user");
    }
    await sleep(120);
    const email = cell(row, [
      "email",
      "email address",
      "e-mail",
      "work email",
      "email_address",
      "lead email",
      "lead_email",
    ]);
    const { first, last, full } = parseName(row);
    const label = full || email || "row";
    const rowStage = effectiveMapEngagement
      ? engagementStageForRow(row, input.args, stage)
      : stage;
    if (!email || !email.includes("@")) {
      failed.push(`${label}: missing email`);
      doneCount += 1;
      return;
    }
    try {
      const person = await requestJson(
        `${ATTIO}/v2/objects/people/records?matching_attribute=email_addresses`,
        {
          method: "PUT",
          headers: attioHeaders(input.apiKey),
          body: JSON.stringify({
            data: {
              values: {
                email_addresses: [{ email_address: email }],
                name: [{ first_name: first || full, last_name: last, full_name: full || email }],
              },
            },
          }),
        },
      );
      const recordId = pickAttioId(person, ["record_id"]);
      if (!recordId) throw new Error("Person was not created");
      const payloads = [
        {
          parent_record_id: recordId,
          parent_object: "people",
          entry_values: rowStage ? { [stageSlug]: rowStage } : {},
        },
        {
          parent_record_id: recordId,
          parent_object: "people",
          entry_values: rowStage ? { [stageSlug]: [{ status: rowStage }] } : {},
        },
      ];
      let listed = false;
      let lastError = "";
      for (const data of payloads) {
        try {
          await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
            method: "PUT",
            headers: attioHeaders(input.apiKey),
            body: JSON.stringify({ data }),
          });
          listed = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : "failed";
        }
      }
      if (!listed) {
        if (rowStage) {
          throw new Error(
            `Could not set stage "${rowStage}" for ${email}: ${lastError || "Attio rejected stage write"}`,
          );
        }
        await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
          method: "POST",
          headers: attioHeaders(input.apiKey),
          body: JSON.stringify({
            data: {
              parent_record_id: recordId,
              parent_object: "people",
              entry_values: {},
            },
          }),
        });
      }
      added.push(full || email);
      const stageKey = rowStage || "(no stage)";
      byStage[stageKey] = (byStage[stageKey] || 0) + 1;
    } catch (err) {
      failed.push(`${label}: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      doneCount += 1;
      if (doneCount === 1 || doneCount === rows.length || doneCount % 25 === 0) {
        await input.onStatus?.(
          `Uploading contacts to Attio… ${doneCount} / ${rows.length}`,
          doneCount,
          rows.length,
        );
      }
    }
  });

  return {
    ok: failed.length === 0,
    list: String(list.name || listName),
    stage: effectiveMapEngagement ? "from CSV engagement" : stage || null,
    mapEngagement: effectiveMapEngagement,
    imported: added.length,
    skipped: failed.length,
    byStage,
    totalInFile: allRows.length,
    importedCap: maxRows,
    truncated: allRows.length > maxRows,
    names: added.slice(0, 25),
    errors: failed.slice(0, 15),
  };
}

/** Threshold: larger imports run as background jobs so chat can finish without network timeout. */
export const ATTIO_IMPORT_BACKGROUND_MIN_ROWS = 25;
