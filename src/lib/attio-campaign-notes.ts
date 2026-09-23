const ATTIO = "https://api.attio.com";

function attioHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatWhen(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export type CampaignNoteKind = "sent" | "opened" | "clicked";

export type CampaignNote = {
  title: string;
  content: string;
  kind: CampaignNoteKind;
};

export function buildCampaignNotes(input: {
  campaignName: string;
  subject?: string;
  stage: string;
  sentAt?: string;
  openedAt?: string;
  clickedAt?: string;
  /** Shown when a timestamp is missing, e.g. "imported from campaign CSV". */
  sourceLabel?: string;
}) {
  const campaign = input.campaignName;
  const subject = input.subject ? `Subject: ${input.subject}` : "";
  const source = input.sourceLabel || "synced from campaign";
  const stageLower = input.stage.toLowerCase();
  const isOpen = Boolean(input.openedAt) || /open/.test(stageLower);
  const isClick = Boolean(input.clickedAt) || /click/.test(stageLower);
  const notes: CampaignNote[] = [];

  notes.push({
    kind: "sent",
    title: `Sent · ${campaign}`.slice(0, 200),
    content: [
      `Campaign: ${campaign}`,
      subject,
      input.sentAt
        ? `Sent to this contact: ${formatWhen(input.sentAt)}`
        : `Sent to this contact (${source}).`,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  if (isOpen) {
    notes.push({
      kind: "opened",
      title: `Opened · ${campaign}`.slice(0, 200),
      content: [
        `Campaign: ${campaign}`,
        subject,
        input.openedAt
          ? `Contact opened the email: ${formatWhen(input.openedAt)}`
          : `Contact opened the email (${source}).`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  if (isClick) {
    notes.push({
      kind: "clicked",
      title: `Clicked · ${campaign}`.slice(0, 200),
      content: [
        `Campaign: ${campaign}`,
        subject,
        input.clickedAt
          ? `Contact clicked a link: ${formatWhen(input.clickedAt)}`
          : `Contact clicked a link (${source}).`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  return notes;
}

type ExistingNotes = {
  titles: Set<string>;
  bodies: string[];
  ok: boolean;
};

async function listPersonNotes(apiKey: string, recordId: string): Promise<ExistingNotes> {
  try {
    const data = (await requestJson(
      `${ATTIO}/v2/notes?parent_object=people&parent_record_id=${encodeURIComponent(recordId)}&limit=50`,
      { headers: attioHeaders(apiKey) },
    )) as {
      data?: Array<{ title?: string; content_plaintext?: string }>;
    };
    const rows = data.data || [];
    return {
      ok: true,
      titles: new Set(
        rows.map((item) => String(item.title || "").trim().toLowerCase()).filter(Boolean),
      ),
      bodies: rows.map((item) => String(item.content_plaintext || "").toLowerCase()),
    };
  } catch {
    return { ok: false, titles: new Set(), bodies: [] };
  }
}

function campaignNoteAlreadyExists(
  existing: ExistingNotes,
  campaignName: string,
  kind: CampaignNoteKind,
  title: string,
) {
  const titleKey = title.trim().toLowerCase();
  if (existing.titles.has(titleKey)) return true;

  const campaign = campaignName.trim().toLowerCase();
  if (!campaign) return false;

  for (const t of existing.titles) {
    if (!t.includes(campaign)) continue;
    if (kind === "sent" && (t.startsWith("sent") || t.startsWith("campaign:"))) return true;
    if (kind === "opened" && t.startsWith("opened")) return true;
    if (kind === "clicked" && t.startsWith("clicked")) return true;
  }

  for (const body of existing.bodies) {
    if (!body.includes(campaign)) continue;
    if (kind === "sent" && (body.includes("synced by nexuses") || body.includes("sent to"))) {
      return true;
    }
    if (kind === "opened" && (body.includes("opened:") || body.includes("opened the email"))) {
      return true;
    }
    if (kind === "clicked" && (body.includes("clicked:") || body.includes("clicked a link"))) {
      return true;
    }
  }
  return false;
}

async function createAttioNote(
  apiKey: string,
  recordId: string,
  note: { title: string; content: string },
) {
  await requestJson(`${ATTIO}/v2/notes`, {
    method: "POST",
    headers: attioHeaders(apiKey),
    body: JSON.stringify({
      data: {
        parent_object: "people",
        parent_record_id: recordId,
        title: note.title.slice(0, 200),
        format: "plaintext",
        content: note.content.slice(0, 8000),
      },
    }),
  });
}

/** Create Sent / Opened / Clicked notes only when missing — never re-add on every sync/import. */
export async function ensureCampaignNotes(
  apiKey: string,
  recordId: string,
  campaignName: string,
  notes: CampaignNote[],
) {
  if (!notes.length) return 0;
  const existing = await listPersonNotes(apiKey, recordId);
  if (!existing.ok) return 0;

  let created = 0;
  for (const note of notes) {
    if (campaignNoteAlreadyExists(existing, campaignName, note.kind, note.title)) continue;
    try {
      await createAttioNote(apiKey, recordId, note);
      existing.titles.add(note.title.trim().toLowerCase());
      existing.bodies.push(note.content.toLowerCase());
      created += 1;
    } catch {
      // Notes require note:read-write — don't fail the whole import
    }
  }
  return created;
}
