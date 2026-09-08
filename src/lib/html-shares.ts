import { randomBytes } from "crypto";
import { dbConnect } from "@/lib/db";
import {
  enhanceSharedHtml,
  renderDataDashboard,
  type DataDashboardInput,
} from "@/lib/html-dashboard-kit";
import { HtmlDraft } from "@/models/HtmlDraft";
import { HtmlShare } from "@/models/HtmlShare";
import { Project } from "@/models/Project";

/** Mongo docs can hold ~16MB; keep headroom for branding wrap. */
export const MAX_SHARE_HTML_CHARS = 2_000_000;
/** Per-chunk size for share_html_append — fits safely in LLM tool args. */
export const MAX_HTML_CHUNK_CHARS = 12_000;
const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;

/** Public site origin for share links. Set APP_URL in .env (no trailing slash). */
export function getAppOrigin(fallback?: string) {
  const normalize = (raw: string) => {
    let value = raw.trim().replace(/\/$/, "");
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) {
      const host = value.split("/")[0]?.toLowerCase() || "";
      const loopback =
        host === "localhost" ||
        host.startsWith("localhost:") ||
        host === "127.0.0.1" ||
        host.startsWith("127.0.0.1:");
      value = `${loopback ? "http" : "https"}://${value}`;
    }
    try {
      return new URL(value).origin;
    } catch {
      return value.replace(/\/$/, "");
    }
  };

  const fromEnv = normalize(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "");
  if (fromEnv) return fromEnv;
  const fromFallback = normalize(fallback || "");
  if (fromFallback) return fromFallback;
  return "http://localhost:3000";
}

export function makePublicId() {
  return randomBytes(9).toString("base64url");
}

export function normalizeSharedHtml(raw: string) {
  const html = raw.trim();
  if (!html) throw new Error("HTML is required");
  if (html.length > MAX_SHARE_HTML_CHARS) {
    throw new Error("HTML is too large to share (max about 2MB)");
  }
  if (!/<[a-z!/?]/i.test(html) && !/\|/.test(html)) {
    throw new Error("That does not look like HTML");
  }
  return html;
}

export function publicSharePath(publicId: string) {
  return `/p/${publicId}`;
}

export function absoluteShareUrl(origin: string, publicId: string) {
  return `${getAppOrigin(origin)}${publicSharePath(publicId)}`;
}

async function resolveClientBranding(input: {
  projectId?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  let clientLogoUrl = (input.clientLogoUrl || "").trim();
  let clientName = (input.clientName || "").trim();
  if (input.projectId) {
    await dbConnect();
    const project = await Project.findById(input.projectId).select("name logo").lean();
    if (project) {
      if (!clientLogoUrl) clientLogoUrl = String(project.logo || "").trim();
      if (!clientName) clientName = String(project.name || "").trim();
    }
  }
  return { clientLogoUrl, clientName };
}

export async function createHtmlShare(input: {
  userId: string;
  projectId?: string;
  html: string;
  title?: string;
  origin?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  await dbConnect();
  const raw = normalizeSharedHtml(input.html);
  const title = (input.title || "Shared HTML").trim().slice(0, 120) || "Shared HTML";
  const branding = await resolveClientBranding(input);
  const html = enhanceSharedHtml(raw, {
    titleHint: title,
    clientLogoUrl: branding.clientLogoUrl,
    clientName: branding.clientName,
  });
  const publicId = makePublicId();

  await HtmlShare.create({
    publicId,
    userId: input.userId,
    projectId: input.projectId || undefined,
    title,
    html,
  });

  return {
    publicId,
    title,
    url: absoluteShareUrl(input.origin || "", publicId),
  };
}

export async function beginHtmlDraft(input: {
  userId: string;
  projectId?: string;
  title?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  await dbConnect();
  const draftId = makePublicId();
  const branding = await resolveClientBranding(input);
  await HtmlDraft.create({
    draftId,
    userId: input.userId,
    projectId: input.projectId || undefined,
    title: (input.title || "").trim().slice(0, 120),
    clientLogoUrl: branding.clientLogoUrl,
    clientName: branding.clientName,
    buffer: "",
    expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
  });
  return {
    draftId,
    maxChunkChars: MAX_HTML_CHUNK_CHARS,
    maxTotalChars: MAX_SHARE_HTML_CHARS,
    note: `Append HTML with share_html_append in chunks of ≤${MAX_HTML_CHUNK_CHARS} chars, then call share_html_finish.`,
  };
}

export async function appendHtmlDraft(input: {
  userId: string;
  draftId: string;
  chunk: string;
}) {
  await dbConnect();
  const draftId = input.draftId.trim();
  const chunk = String(input.chunk || "");
  if (!draftId) throw new Error("draft_id is required");
  if (!chunk) throw new Error("chunk is required");
  if (chunk.length > MAX_HTML_CHUNK_CHARS) {
    throw new Error(
      `Chunk too large (${chunk.length} chars). Split into pieces of ≤${MAX_HTML_CHUNK_CHARS} characters.`,
    );
  }

  const draft = await HtmlDraft.findOne({ draftId, userId: input.userId });
  if (!draft) throw new Error("Draft not found or expired — call share_html_begin again");

  const nextLen = String(draft.buffer || "").length + chunk.length;
  if (nextLen > MAX_SHARE_HTML_CHARS) {
    throw new Error(`Draft would exceed max size (${MAX_SHARE_HTML_CHARS} chars)`);
  }

  draft.buffer = `${draft.buffer || ""}${chunk}`;
  draft.expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
  await draft.save();

  return {
    draftId,
    bytesSoFar: draft.buffer.length,
    remainingChars: MAX_SHARE_HTML_CHARS - draft.buffer.length,
  };
}

export async function finishHtmlDraft(input: {
  userId: string;
  draftId: string;
  origin?: string;
  title?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  await dbConnect();
  const draftId = input.draftId.trim();
  if (!draftId) throw new Error("draft_id is required");

  const draft = await HtmlDraft.findOne({ draftId, userId: input.userId });
  if (!draft) throw new Error("Draft not found or expired — call share_html_begin again");

  const html = String(draft.buffer || "").trim();
  if (!html) throw new Error("Draft is empty — append HTML chunks first");

  const share = await createHtmlShare({
    userId: input.userId,
    projectId: draft.projectId ? String(draft.projectId) : undefined,
    html,
    title: input.title || draft.title || undefined,
    origin: input.origin,
    clientLogoUrl: input.clientLogoUrl || draft.clientLogoUrl || undefined,
    clientName: input.clientName || draft.clientName || undefined,
  });

  await HtmlDraft.deleteOne({ _id: draft._id });
  return share;
}

export async function createDataDashboardShare(input: {
  userId: string;
  projectId?: string;
  origin?: string;
  dashboard: DataDashboardInput;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  const branding = await resolveClientBranding({
    projectId: input.projectId,
    clientLogoUrl: input.clientLogoUrl || input.dashboard.clientLogoUrl,
    clientName: input.clientName || input.dashboard.clientName,
  });
  const html = renderDataDashboard({
    ...input.dashboard,
    clientLogoUrl: branding.clientLogoUrl,
    clientName: branding.clientName,
  });
  return createHtmlShare({
    userId: input.userId,
    projectId: input.projectId,
    html,
    title: input.dashboard.title,
    origin: input.origin,
    clientLogoUrl: branding.clientLogoUrl,
    clientName: branding.clientName,
  });
}

export async function getHtmlShareByPublicId(publicId: string) {
  await dbConnect();
  return HtmlShare.findOne({ publicId }).lean();
}

export async function renderHtmlSharePage(publicId: string) {
  const share = await getHtmlShareByPublicId(publicId);
  if (!share) return null;
  const branding = await resolveClientBranding({
    projectId: share.projectId ? String(share.projectId) : undefined,
  });
  return {
    title: share.title || "Nexuses dashboard",
    html: enhanceSharedHtml(String(share.html || ""), {
      titleHint: share.title || "Nexuses dashboard",
      clientLogoUrl: branding.clientLogoUrl,
      clientName: branding.clientName,
    }),
  };
}

/** Pull the first ```html fenced block from an assistant reply. */
export function extractHtmlFence(content: string) {
  const match = content.match(/```(?:html|htm)\s*\n([\s\S]*?)```/i);
  return match?.[1]?.trim() || "";
}

export function parseShareUrlFromToolResult(result: string) {
  try {
    const data = JSON.parse(result) as { url?: string; ok?: boolean };
    if (data?.url && /\/p\/[A-Za-z0-9_-]+/.test(data.url)) return String(data.url);
  } catch {
    const match = result.match(/https?:\/\/[^\s"'\\]+\/p\/[A-Za-z0-9_-]+/);
    if (match) return match[0];
  }
  return "";
}

/** Remove invented /p/... links that were never created by share_html. */
export function scrubInventedShareUrls(content: string, realUrls: string[]) {
  const allowed = new Set(realUrls.filter(Boolean));
  return content
    .replace(/https?:\/\/[^\s)\]>"']+\/p\/[A-Za-z0-9_-]+/g, (url) => {
      if (allowed.has(url)) return url;
      const id = url.split("/p/")[1] || "";
      if ([...allowed].some((real) => real.endsWith(`/p/${id}`))) return url;
      return "";
    })
    .replace(/\[([^\]]*)\]\(\s*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Guarantee dashboard replies include a real working share URL.
 * The model sometimes invents /p/ links — we scrub those and create a real share when needed.
 */
export async function ensureLiveShareInReply(input: {
  content: string;
  userText: string;
  realShareUrls: string[];
  userId: string;
  projectId?: string;
  projectLogo?: string;
  projectName?: string;
  origin?: string;
}) {
  let content = scrubInventedShareUrls(input.content, input.realShareUrls);
  const real = [...input.realShareUrls];

  if (real.length) {
    if (!real.some((url) => content.includes(url))) {
      content = `${content}\n\n**Live dashboard:** ${real[real.length - 1]}`.trim();
    }
    return content;
  }

  const wantsLive =
    /dashboard|share|public link|live link|beautiful|html report|shareable/i.test(input.userText) ||
    /live dashboard|share link|public link/i.test(content);
  const html = extractHtmlFence(content);
  if (!wantsLive || !html) return content;

  try {
    const share = await createHtmlShare({
      userId: input.userId,
      projectId: input.projectId,
      html,
      title: "Campaign dashboard",
      origin: input.origin,
      clientLogoUrl: input.projectLogo,
      clientName: input.projectName,
    });
    content = scrubInventedShareUrls(content, [share.url]);
    if (!content.includes(share.url)) {
      content = `${content}\n\n**Live dashboard:** ${share.url}`.trim();
    }
  } catch {
    content = `${content}\n\n_I could not publish a live link automatically — use the Share link button on the HTML preview._`.trim();
  }
  return content;
}
