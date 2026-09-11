/** Map spreadsheet columns → Attio People (and Company) attributes on import. */

type AttrMeta = {
  api_slug?: string;
  title?: string;
  type?: string;
  is_writable?: boolean;
  is_archived?: boolean;
};

const SKIP_HEADERS = new Set([
  "",
  "#",
  "email",
  "email address",
  "e-mail",
  "work email",
  "email_address",
  "lead email",
  "lead_email",
  "name",
  "person name",
  "full name",
  "full_name",
  "contact",
  "lead name",
  "lead_name",
  "contact name",
  "first name",
  "first_name",
  "firstname",
  "first",
  "last name",
  "last_name",
  "lastname",
  "last",
  "surname",
  "_section",
  "opened",
  "clicked",
  "sent",
  "open count",
  "click count",
  "opens",
  "clicks",
  "opened time",
  "clicked time",
  "sent time",
  "open date",
  "open time",
  "send date",
  "send time",
  "cta clicked",
  "status",
  "step",
  "campaign",
  "campaign id",
  "campaign_id",
]);

/** Standard / preferred People attribute slugs for common CSV headers. */
const PEOPLE_ALIASES: Array<{ slug: string; type: "text" | "phone" | "url"; keys: string[] }> = [
  {
    slug: "job_title",
    type: "text",
    keys: ["job title", "job_title", "job position", "position", "title", "role", "designation"],
  },
  {
    slug: "linkedin",
    type: "text",
    keys: [
      "linkedin",
      "linkedin url",
      "linkedin_url",
      "linkedin profile",
      "linkedinprofile",
      "li url",
      "li profile",
    ],
  },
  {
    slug: "description",
    type: "text",
    keys: ["description", "notes", "bio", "about"],
  },
  {
    slug: "phone_numbers",
    type: "phone",
    keys: ["phone", "phone number", "mobile", "mobile number", "cell"],
  },
];

const COMPANY_KEYS = [
  "company",
  "company name",
  "company_name",
  "organization",
  "organisation",
  "account",
  "account name",
];

const WEBSITE_KEYS = [
  "company website",
  "website",
  "company_website",
  "domain",
  "company domain",
  "url",
  "web",
];

function normHeader(value: string) {
  return value.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
}

function slugifyAttr(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
}

function cell(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const want = key.replace(/[_\s]+/g, "");
    const match = Object.keys(row).find((header) => {
      const h = header.trim().toLowerCase();
      return h === key || h.replace(/[_\s]+/g, "") === want;
    });
    if (match && row[match]?.trim()) return row[match].trim();
  }
  return "";
}

function extractDomain(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  try {
    const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const host = new URL(withProto).hostname.replace(/^www\./i, "");
    if (host.includes(".") && !host.includes(" ")) return host.toLowerCase();
  } catch {
    // fall through
  }
  const cleaned = value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .trim()
    .toLowerCase();
  return cleaned.includes(".") && !cleaned.includes(" ") ? cleaned : "";
}

function domainFromEmail(email: string) {
  const host = email.split("@")[1]?.trim().toLowerCase() || "";
  if (!host || /gmail|yahoo|hotmail|outlook|icloud|proton|aol\./i.test(host)) return "";
  return host;
}

type RequestJson = (url: string, init: RequestInit) => Promise<unknown>;

async function listPeopleAttributes(apiKey: string, requestJson: RequestJson) {
  const data = (await requestJson("https://api.attio.com/v2/objects/people/attributes", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  })) as { data?: AttrMeta[] };
  return (data.data || []).filter((item) => !item.is_archived);
}

async function ensureTextAttribute(
  apiKey: string,
  requestJson: RequestJson,
  existing: AttrMeta[],
  title: string,
  preferredSlug?: string,
): Promise<{ slug: string; created: boolean }> {
  const slug = preferredSlug || slugifyAttr(title);
  const found = existing.find(
    (item) =>
      item.api_slug === slug ||
      normHeader(item.title || "") === normHeader(title) ||
      normHeader(item.api_slug || "") === normHeader(title),
  );
  if (found?.api_slug) return { slug: found.api_slug, created: false };

  try {
    const created = (await requestJson("https://api.attio.com/v2/objects/people/attributes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          title,
          description: `Imported from spreadsheet (${title})`,
          api_slug: slug,
          type: "text",
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      }),
    })) as { data?: { api_slug?: string } };
    const createdSlug = created?.data?.api_slug || slug;
    existing.push({ api_slug: createdSlug, title, type: "text" });
    return { slug: createdSlug, created: true };
  } catch {
    const refreshed = await listPeopleAttributes(apiKey, requestJson);
    existing.splice(0, existing.length, ...refreshed);
    const again = existing.find(
      (item) =>
        item.api_slug === slug ||
        normHeader(item.title || "") === normHeader(title) ||
        normHeader(item.api_slug || "") === normHeader(title),
    );
    return { slug: again?.api_slug || "", created: false };
  }
}

export type PersonFieldPlan = {
  /** People attribute slug → CSV header keys */
  mappings: Array<{ slug: string; keys: string[]; kind: "text" | "phone" | "url" | "standard" }>;
  created: string[];
  used: string[];
};

/**
 * Ensure People attributes exist for every useful CSV column, then return write plan.
 */
export async function preparePersonFieldPlan(
  apiKey: string,
  requestJson: RequestJson,
  sampleRows: Record<string, string>[],
  onStatus?: (text: string) => void | Promise<void>,
): Promise<PersonFieldPlan> {
  const headers = new Set<string>();
  for (const row of sampleRows.slice(0, 50)) {
    for (const key of Object.keys(row)) {
      const n = normHeader(key);
      if (!n || SKIP_HEADERS.has(n)) continue;
      if (COMPANY_KEYS.includes(n) || WEBSITE_KEYS.includes(n)) continue;
      headers.add(n);
    }
  }

  await onStatus?.("Checking Attio People attributes for CSV columns…");
  const existing = await listPeopleAttributes(apiKey, requestJson);
  const created: string[] = [];
  const mappings: PersonFieldPlan["mappings"] = [];

  for (const alias of PEOPLE_ALIASES) {
    const hasData = sampleRows.some((row) => cell(row, alias.keys));
    if (!hasData) continue;
    const existingSlug = existing.find((item) => item.api_slug === alias.slug)?.api_slug || "";
    let slug = existingSlug;
    if (!slug && alias.slug !== "phone_numbers") {
      const ensured = await ensureTextAttribute(
        apiKey,
        requestJson,
        existing,
        alias.keys[0].replace(/\b\w/g, (c) => c.toUpperCase()),
        alias.slug,
      );
      slug = ensured.slug;
      if (ensured.created) created.push(ensured.slug);
    } else if (!slug) {
      slug = alias.slug;
    }
    if (!slug) continue;
    mappings.push({ slug, keys: alias.keys, kind: alias.type });
  }

  for (const header of headers) {
    if (PEOPLE_ALIASES.some((alias) => alias.keys.includes(header))) continue;
    const title = header.replace(/\b\w/g, (c) => c.toUpperCase());
    const ensured = await ensureTextAttribute(
      apiKey,
      requestJson,
      existing,
      title,
      slugifyAttr(header),
    );
    if (!ensured.slug) continue;
    if (ensured.created) created.push(ensured.slug);
    mappings.push({ slug: ensured.slug, keys: [header], kind: "text" });
  }

  return {
    mappings,
    created,
    used: mappings.map((item) => item.slug),
  };
}

export async function assertCompanyForRow(
  apiKey: string,
  requestJson: RequestJson,
  row: Record<string, string>,
  email: string,
) {
  const companyName = cell(row, COMPANY_KEYS);
  const website = cell(row, WEBSITE_KEYS);
  const domain = extractDomain(website) || domainFromEmail(email);
  if (!companyName && !domain) return "";

  const values: Record<string, unknown> = {};
  if (domain) values.domains = [{ domain }];
  if (companyName) values.name = [{ value: companyName }];

  const matching = domain ? "domains" : "name";
  try {
    const company = (await requestJson(
      `https://api.attio.com/v2/objects/companies/records?matching_attribute=${matching}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { values } }),
      },
    )) as { data?: { id?: { record_id?: string } } };
    return company?.data?.id?.record_id || "";
  } catch {
    if (matching === "domains" && companyName) {
      try {
        const company = (await requestJson(
          "https://api.attio.com/v2/objects/companies/records?matching_attribute=name",
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              data: { values: { name: [{ value: companyName }] } },
            }),
          },
        )) as { data?: { id?: { record_id?: string } } };
        return company?.data?.id?.record_id || "";
      } catch {
        return "";
      }
    }
    return "";
  }
}

export function buildPersonValuesFromRow(
  row: Record<string, string>,
  plan: PersonFieldPlan,
  companyRecordId: string,
) {
  const values: Record<string, unknown> = {};
  const written: string[] = [];

  for (const mapping of plan.mappings) {
    const raw = cell(row, mapping.keys);
    if (!raw) continue;
    if (mapping.kind === "phone" || mapping.slug === "phone_numbers") {
      values.phone_numbers = [{ original_phone_number: raw }];
      written.push("phone_numbers");
      continue;
    }
    values[mapping.slug] = [{ value: raw }];
    written.push(mapping.slug);
  }

  if (companyRecordId) {
    values.company = [
      {
        target_object: "companies",
        target_record_id: companyRecordId,
      },
    ];
    written.push("company");
  }

  return { values, written };
}
