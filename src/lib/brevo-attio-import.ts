import { exportBrevoCampaignRecipientsFull } from "@/lib/brevo-recipients";

const ATTIO = "https://api.attio.com";

type Person = { email: string; name: string; stage: string; campaigns: string[] };

function attioHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function requestJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 800)}`);
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

function stageRank(stage: string, order: string[]) {
  const idx = order.findIndex((s) => s.toLowerCase() === stage.toLowerCase());
  return idx >= 0 ? idx : -1;
}

function pickHigherStage(current: string | undefined, next: string, order: string[]) {
  if (!current) return next;
  return stageRank(next, order) > stageRank(current, order) ? next : current;
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

async function ensureListStages(
  apiKey: string,
  listId: string,
  stageSlug: string,
  stages: string[],
) {
  for (const stage of stages) {
    try {
      await requestJson(
        `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes/${encodeURIComponent(stageSlug)}/statuses`,
        {
          method: "POST",
          headers: attioHeaders(apiKey),
          body: JSON.stringify({ data: { title: stage } }),
        },
      );
    } catch {
      // already exists
    }
  }
}

async function resolveAttioList(apiKey: string, listName: string) {
  const lists = (await requestJson(`${ATTIO}/v2/lists`, {
    headers: attioHeaders(apiKey),
  })) as { data?: { name?: string; api_slug?: string; id?: { list_id?: string } }[] };
  const list = (lists.data || []).find(
    (item) =>
      item.name?.toLowerCase() === listName.toLowerCase() ||
      item.api_slug?.toLowerCase() === slugify(listName),
  );
  if (!list) {
    const names = (lists.data || []).map((item) => item.name).filter(Boolean);
    throw new Error(`No Attio list named "${listName}". Available: ${names.join(", ") || "none"}`);
  }
  const listId = list.id?.list_id || list.api_slug || "";
  const attributes = (await requestJson(
    `${ATTIO}/v2/lists/${encodeURIComponent(listId)}/attributes`,
    { headers: attioHeaders(apiKey) },
  )) as { data?: { api_slug?: string; title?: string; type?: string }[] };
  const statusAttr =
    (attributes.data || []).find(
      (item) => item.type === "status" && /stage|status/i.test(item.api_slug || item.title || ""),
    ) || (attributes.data || []).find((item) => item.type === "status");
  return {
    name: String(list.name || listName),
    id: listId,
    stageSlug: statusAttr?.api_slug || "stage",
  };
}

async function upsertPersonWithStage(
  apiKey: string,
  listId: string,
  stageSlug: string,
  person: { email: string; name?: string },
  stage: string,
) {
  const [first = "", ...rest] = (person.name || "").split(/\s+/);
  const last = rest.join(" ");
  const created = await requestJson(
    `${ATTIO}/v2/objects/people/records?matching_attribute=email_addresses`,
    {
      method: "PUT",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({
        data: {
          values: {
            email_addresses: [{ email_address: person.email }],
            name: [
              {
                first_name: first || person.email,
                last_name: last,
                full_name: person.name || person.email,
              },
            ],
          },
        },
      }),
    },
  );
  const recordId =
    (created as { data?: { id?: { record_id?: string } } })?.data?.id?.record_id || "";
  if (!recordId) throw new Error(`Could not upsert ${person.email}`);

  const payloads = [
    {
      parent_record_id: recordId,
      parent_object: "people",
      entry_values: { [stageSlug]: stage },
    },
    {
      parent_record_id: recordId,
      parent_object: "people",
      entry_values: { [stageSlug]: [{ status: stage }] },
    },
  ];
  let lastError = "";
  for (const data of payloads) {
    try {
      await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
        method: "PUT",
        headers: attioHeaders(apiKey),
        body: JSON.stringify({ data }),
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : "failed";
    }
  }
  try {
    await requestJson(`${ATTIO}/v2/lists/${encodeURIComponent(listId)}/entries`, {
      method: "POST",
      headers: attioHeaders(apiKey),
      body: JSON.stringify({ data: payloads[0] }),
    });
  } catch (err) {
    throw new Error(
      `Could not add ${person.email} to list with stage "${stage}": ${
        err instanceof Error ? err.message : lastError || "failed"
      }`,
    );
  }
}

/**
 * Full multi-campaign Brevo → Attio import with engagement stages.
 * Pulls clickers, openers, and all recipients per campaign (full export, not samples).
 */
export async function importBrevoCampaignsToAttio(input: {
  attioApiKey: string;
  brevoApiKey: string;
  brevoRestApiKey?: string;
  brevoMcpUrl?: string;
  campaigns: string[];
  attioList: string;
  stageProspect?: string;
  stageOpen?: string;
  stageClick?: string;
  onStatus?: (text: string, done?: number, total?: number) => void | Promise<void>;
  shouldCancel?: () => boolean;
}) {
  const stageProspect = String(input.stageProspect || "Prospect").trim() || "Prospect";
  const stageOpen = String(input.stageOpen || "Open").trim() || "Open";
  const stageClick = String(input.stageClick || "Click").trim() || "Click";
  const stageOrder = [stageProspect, stageOpen, stageClick];

  const campaigns = input.campaigns.map((c) => String(c || "").trim()).filter(Boolean);
  if (!campaigns.length) throw new Error("At least one Brevo campaign name is required");
  if (!input.attioList.trim()) throw new Error("Attio list name is required");

  await input.onStatus?.(`Looking up Attio list “${input.attioList}”…`);
  const list = await resolveAttioList(input.attioApiKey, input.attioList.trim());
  await ensureListStages(input.attioApiKey, list.id, list.stageSlug, stageOrder);

  const merged = new Map<string, Person>();
  const perCampaign: Array<{
    campaign: string;
    all: number;
    opens: number;
    clicks: number;
    error?: string;
  }> = [];
  const campaignErrors: string[] = [];

  for (const [index, campaign] of campaigns.entries()) {
    if (input.shouldCancel?.()) throw new Error("Stopped by user");
    await input.onStatus?.(
      `Exporting Brevo campaign ${index + 1}/${campaigns.length}: ${campaign}…`,
    );

    try {
      // Sequential exports per campaign (Brevo rate limits / process queue)
      const clicks = await exportBrevoCampaignRecipientsFull({
        apiKey: input.brevoApiKey,
        restApiKey: input.brevoRestApiKey,
        mcpUrl: input.brevoMcpUrl,
        campaign,
        event: "clicks",
        onStatus: (t) => input.onStatus?.(`${campaign}: ${t}`),
      });
      const opens = await exportBrevoCampaignRecipientsFull({
        apiKey: input.brevoApiKey,
        restApiKey: input.brevoRestApiKey,
        mcpUrl: input.brevoMcpUrl,
        campaign,
        event: "opens",
        onStatus: (t) => input.onStatus?.(`${campaign}: ${t}`),
      });
      const all = await exportBrevoCampaignRecipientsFull({
        apiKey: input.brevoApiKey,
        restApiKey: input.brevoRestApiKey,
        mcpUrl: input.brevoMcpUrl,
        campaign,
        event: "all",
        onStatus: (t) => input.onStatus?.(`${campaign}: ${t}`),
      });

      perCampaign.push({
        campaign: all.campaignName || campaign,
        all: all.people.length,
        opens: opens.people.length,
        clicks: clicks.people.length,
      });

      const apply = (
        people: Array<{ email: string; name: string }>,
        stage: string,
        campaignName: string,
      ) => {
        for (const person of people) {
          const email = person.email.toLowerCase();
          const existing = merged.get(email);
          if (!existing) {
            merged.set(email, {
              email,
              name: person.name,
              stage,
              campaigns: [campaignName],
            });
            continue;
          }
          existing.stage = pickHigherStage(existing.stage, stage, stageOrder);
          if (person.name && !existing.name) existing.name = person.name;
          if (!existing.campaigns.includes(campaignName)) existing.campaigns.push(campaignName);
        }
      };

      const campaignName = all.campaignName || campaign;
      apply(all.people, stageProspect, campaignName);
      apply(opens.people, stageOpen, campaignName);
      apply(clicks.people, stageClick, campaignName);
    } catch (err) {
      const message = err instanceof Error ? err.message : "export failed";
      campaignErrors.push(`${campaign}: ${message}`);
      perCampaign.push({
        campaign,
        all: 0,
        opens: 0,
        clicks: 0,
        error: message,
      });
      await input.onStatus?.(
        `Skipped campaign ${index + 1}/${campaigns.length} (${message}). Continuing…`,
      );
    }
  }

  if (!merged.size) {
    throw new Error(
      campaignErrors.length
        ? `No recipients imported. Campaign errors: ${campaignErrors.slice(0, 5).join(" | ")}`
        : "No recipients found across the given Brevo campaigns.",
    );
  }

  const people = [...merged.values()];
  const added: string[] = [];
  const failed: string[] = [];
  let done = 0;

  await input.onStatus?.(
    `Importing ${people.length.toLocaleString()} unique contacts into Attio “${list.name}”…`,
    0,
    people.length,
  );

  await mapPool(people, 8, async (person) => {
    if (input.shouldCancel?.()) throw new Error("Stopped by user");
    try {
      await upsertPersonWithStage(
        input.attioApiKey,
        list.id,
        list.stageSlug,
        person,
        person.stage,
      );
      added.push(person.email);
    } catch (err) {
      failed.push(`${person.email}: ${err instanceof Error ? err.message : "failed"}`);
    } finally {
      done += 1;
      if (done === 1 || done === people.length || done % 50 === 0) {
        await input.onStatus?.(
          `Uploading to Attio… ${done} / ${people.length}`,
          done,
          people.length,
        );
      }
    }
  });

  const byStage: Record<string, number> = {
    [stageProspect]: 0,
    [stageOpen]: 0,
    [stageClick]: 0,
  };
  for (const person of people) {
    byStage[person.stage] = (byStage[person.stage] || 0) + 1;
  }

  const rawSum = perCampaign.reduce((sum, row) => sum + row.all, 0);

  return {
    ok: failed.length === 0 && campaignErrors.length === 0,
    list: list.name,
    imported: added.length,
    skipped: failed.length,
    uniquePeople: people.length,
    rawRecipientSum: rawSum,
    byStage,
    perCampaign,
    campaignErrors,
    errors: [...campaignErrors, ...failed].slice(0, 20),
    note:
      "Imported from full Brevo recipient exports (all + opens + clicks), deduped by email with highest stage kept. Campaigns that could not be resolved were skipped.",
  };
}
