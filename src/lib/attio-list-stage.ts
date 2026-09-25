const ATTIO = "https://api.attio.com";

type AttioRequest = (url: string, init: RequestInit) => Promise<unknown>;

/** Prospect < Open < Click < Reply. Unknown labels rank as 0. */
export function engagementStageRank(stage: string): number {
  const s = stage.trim().toLowerCase();
  if (!s) return 0;
  if (/repl/.test(s) || s === "hot") return 4;
  if (/click/.test(s)) return 3;
  if (/open/.test(s)) return 2;
  if (/prospect|sent|deliver/.test(s)) return 1;
  return 0;
}

/** True only when the new campaign stage is strictly higher than the current list stage. */
export function shouldRaiseListStage(current: string, next: string): boolean {
  if (!next.trim()) return false;
  if (!current.trim()) return true;
  const currentRank = engagementStageRank(current);
  const nextRank = engagementStageRank(next);
  if (currentRank === 0 || nextRank === 0) return false;
  return nextRank > currentRank;
}

function statusTitle(stageVal: unknown): string {
  if (typeof stageVal === "string") return stageVal.trim();
  if (!Array.isArray(stageVal)) return "";
  for (const item of stageVal) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.active_until) continue;
    const status = row.status;
    if (typeof status === "string" && status.trim()) return status.trim();
    if (status && typeof status === "object") {
      const title = String((status as { title?: string }).title || "").trim();
      if (title) return title;
    }
    const title = String(row.title || row.value || "").trim();
    if (title) return title;
  }
  return "";
}

/**
 * Stage to write onto the list, or null to leave the current stage alone.
 * Lookup failure falls back to writing `nextStage` so a new contact is still added.
 */
export async function stageToWrite(input: {
  listId: string;
  recordId: string;
  stageSlug: string;
  nextStage: string;
  request: AttioRequest;
}): Promise<string | null> {
  const nextStage = input.nextStage.trim();
  if (!nextStage) return null;
  try {
    const current = await readPersonListStage(input);
    if (!current.onList || !current.stage.trim()) return nextStage;
    if (shouldRaiseListStage(current.stage, nextStage)) return nextStage;
    return null;
  } catch {
    return nextStage;
  }
}

async function readPersonListStage(input: {
  listId: string;
  recordId: string;
  stageSlug: string;
  request: AttioRequest;
}): Promise<{ onList: boolean; stage: string }> {
  const memberships = (await input.request(
    `${ATTIO}/v2/objects/people/records/${encodeURIComponent(input.recordId)}/entries?limit=200`,
    { method: "GET" },
  )) as {
    data?: Array<{ list_id?: string; list_api_slug?: string; entry_id?: string }>;
  };
  const match = (memberships.data || []).find(
    (item) =>
      item.entry_id &&
      (item.list_id === input.listId || item.list_api_slug === input.listId),
  );
  if (!match?.entry_id) return { onList: false, stage: "" };

  const entry = (await input.request(
    `${ATTIO}/v2/lists/${encodeURIComponent(input.listId)}/entries/${encodeURIComponent(match.entry_id)}`,
    { method: "GET" },
  )) as { data?: { entry_values?: Record<string, unknown> } };

  return {
    onList: true,
    stage: statusTitle(entry.data?.entry_values?.[input.stageSlug]),
  };
}
