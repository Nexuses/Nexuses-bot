import { parseEngagementDate } from "@/lib/attio-import";

export type EngagementSyncPerson = {
  email: string;
  name: string;
  stage: string;
  sentAt?: string;
  openedAt?: string;
  clickedAt?: string;
};

/** Same rule as CSV import: open/click must be at least `minSeconds` after send/delivery. */
export function applyRealEngagementUnifiedPeople(
  people: EngagementSyncPerson[],
  stages: { prospect: string; open: string; click: string },
  minSeconds = 45,
): EngagementSyncPerson[] {
  const minMs = Math.max(0, minSeconds) * 1000;

  return people.map((person) => {
    const send = parseEngagementDate(String(person.sentAt || ""));
    if (!send) return person;

    const openAt = person.openedAt ? parseEngagementDate(person.openedAt) : null;
    const clickAt = person.clickedAt ? parseEngagementDate(person.clickedAt) : null;

    const openReal = Boolean(openAt && openAt.getTime() - send.getTime() >= minMs);
    const clickReal = Boolean(clickAt && clickAt.getTime() - send.getTime() >= minMs);

    // Clicks list with no click timestamp: require a real open window (matches CSV click-count rule).
    const inferredClick =
      clickReal ||
      (!clickAt && person.stage === stages.click && openReal);

    let stage = stages.prospect;
    if (inferredClick) stage = stages.click;
    else if (openReal) stage = stages.open;

    return {
      ...person,
      openedAt: openReal ? person.openedAt : undefined,
      clickedAt: clickReal ? person.clickedAt : undefined,
      stage,
    };
  });
}
