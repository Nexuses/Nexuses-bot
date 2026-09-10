const ATTIO = "https://api.attio.com";

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
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

export function parseCsv(text: string) {
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

  if (table.length < 2) return [] as Record<string, string>[];
  const headers = table[0].map((header) => header.trim().toLowerCase());
  return table.slice(1).map((cols) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = (cols[index] || "").trim().replace(/^"|"$/g, "");
    });
    return record;
  });
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

function parseName(row: Record<string, string>) {
  const full = cell(row, ["name", "full name", "full_name", "contact", "lead name", "lead_name"]);
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
  if (f === "opened" || f === "open") {
    return (
      hasEngagementValue(cell(row, ["opened time", "opened_time", "open time", "opened"])) ||
      Number(cell(row, ["open count", "open_count", "opens"]) || 0) > 0
    );
  }
  if (f === "clicked" || f === "click") {
    return (
      hasEngagementValue(cell(row, ["clicked time", "clicked_time", "click time", "clicked"])) ||
      Number(cell(row, ["click count", "click_count", "clicks"]) || 0) > 0
    );
  }
  if (f === "replied" || f === "reply") {
    return (
      hasEngagementValue(cell(row, ["replied time", "replied_time", "reply time", "replied"])) ||
      hasEngagementValue(cell(row, ["reply message", "reply_message", "reply"]))
    );
  }
  if (f === "sent") {
    return (
      hasEngagementValue(cell(row, ["sent time", "sent_time", "sent"])) ||
      hasEngagementValue(cell(row, ["sent email", "sent_email"]))
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
  const stageClick = String(args.stage_click || args.stageClick || "click").trim() || "click";
  const stageOpen = String(args.stage_open || args.stageOpen || "open").trim() || "open";
  const stageSent =
    String(args.stage_sent || args.stageSent || fallbackStage || "sent").trim() || "sent";
  if (rowMatchesCsvFilter(row, "replied")) return stageReply;
  if (rowMatchesCsvFilter(row, "clicked")) return stageClick;
  if (rowMatchesCsvFilter(row, "opened")) return stageOpen;
  if (rowMatchesCsvFilter(row, "sent")) return stageSent;
  return fallbackStage || "prospect";
}

function csvLooksLikeEngagement(rows: Record<string, string>[]) {
  const sample = rows[0] || {};
  const keys = Object.keys(sample).join(" ");
  return /opened|clicked|replied|sent time|open count|click count/i.test(keys);
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
  totalInFile: number;
  importedCap: number;
  truncated: boolean;
  names: string[];
  errors: string[];
};

export async function runAttioCsvImportFromText(input: {
  apiKey: string;
  args: Record<string, unknown>;
  csvText: string;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
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
    (!stage && csvLooksLikeEngagement(rows));

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
  if (mapEngagement) {
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
  let doneCount = 0;
  const modeNote = mapEngagement
    ? " with stages from CSV engagement"
    : stage
      ? ` onto "${stage}"`
      : "";
  await input.onStatus?.(
    `Found the list. Importing ${rows.length.toLocaleString()} contact${rows.length === 1 ? "" : "s"}${modeNote}…`,
    0,
    rows.length,
  );

  await mapPool(rows, 8, async (row) => {
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
    const rowStage = mapEngagement ? engagementStageForRow(row, input.args, stage) : stage;
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
        { parent_record_id: recordId, parent_object: "people", entry_values: {} },
      ];
      let listed = false;
      for (const data of payloads) {
        try {
          await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
            method: "PUT",
            headers: attioHeaders(input.apiKey),
            body: JSON.stringify({ data }),
          });
          listed = true;
          break;
        } catch {
          // try next payload shape
        }
      }
      if (!listed) {
        await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
          method: "POST",
          headers: attioHeaders(input.apiKey),
          body: JSON.stringify({ data: payloads[0] }),
        });
      }
      added.push(full || email);
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
    stage: mapEngagement ? "from CSV engagement" : stage || null,
    mapEngagement,
    imported: added.length,
    skipped: failed.length,
    totalInFile: allRows.length,
    importedCap: maxRows,
    truncated: allRows.length > maxRows,
    names: added.slice(0, 25),
    errors: failed.slice(0, 15),
  };
}

/** Threshold: larger imports run as background jobs so chat can finish without network timeout. */
export const ATTIO_IMPORT_BACKGROUND_MIN_ROWS = 25;
