import { lookup } from "dns/promises";
import net from "net";

const MAX_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 40_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;

function isPrivateIp(ip: string) {
  const version = net.isIP(ip);
  if (!version) return true;

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
  if (normalized.startsWith("fe80")) return true; // link-local
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIp(normalized.slice(7));
  }
  return false;
}

async function assertPublicHostname(hostname: string) {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) throw new Error("URL is missing a host");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Local hostnames are not allowed");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Private IP addresses are not allowed");
    return;
  }

  let records: { address: string }[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not resolve host: ${host}`);
  }
  if (!records.length) throw new Error(`Could not resolve host: ${host}`);
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error("That host resolves to a private network address");
    }
  }
}

function normalizeUrl(raw: string) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  return url;
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function readLimitedBody(res: Response) {
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("Page is too large to fetch");
    return text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error("Page is too large to fetch (max about 1.5MB)");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Fetch a public http(s) page for the chat agent.
 * Blocks private/local IPs (SSRF), caps size/time, returns plain text.
 */
export async function fetchPublicUrl(rawUrl: string) {
  let current = normalizeUrl(rawUrl);
  await assertPublicHostname(current.hostname);

  let res: Response | null = null;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.5",
          "User-Agent": "NexusesBot/1.0 (+https://nexuses.com; fetch_url)",
        },
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error("Timed out fetching that URL");
      }
      throw new Error(err instanceof Error ? err.message : "Could not fetch that URL");
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect without a Location header");
      current = normalizeUrl(new URL(location, current).toString());
      await assertPublicHostname(current.hostname);
      continue;
    }
    break;
  }

  if (!res) throw new Error("Could not fetch that URL");
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const raw = await readLimitedBody(res);
  let text = raw;
  let format: "html" | "json" | "text" = "text";

  if (contentType.includes("application/json") || /^\s*[\[{]/.test(raw)) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
      format = "json";
    } catch {
      format = "text";
    }
  } else if (contentType.includes("html") || /<html[\s>]/i.test(raw) || /<!doctype\s+html/i.test(raw)) {
    text = htmlToText(raw);
    format = "html";
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n…truncated`;

  return {
    ok: true as const,
    url: current.toString(),
    status: res.status,
    contentType: contentType || "unknown",
    format,
    truncated,
    chars: text.length,
    text,
  };
}
