import { randomBytes } from "crypto";
import { dbConnect } from "@/lib/db";
import { enhanceSharedHtml } from "@/lib/html-dashboard-kit";
import { HtmlShare } from "@/models/HtmlShare";
import { Project } from "@/models/Project";

export const MAX_SHARE_HTML_CHARS = 400_000;

/** Public site origin for share links. Set APP_URL in .env (no trailing slash). */
export function getAppOrigin(fallback?: string) {
  const fromEnv = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (fallback) return fallback.replace(/\/$/, "");
  return "http://localhost:3000";
}

export function makePublicId() {
  return randomBytes(9).toString("base64url");
}

export function normalizeSharedHtml(raw: string) {
  const html = raw.trim();
  if (!html) throw new Error("HTML is required");
  if (html.length > MAX_SHARE_HTML_CHARS) {
    throw new Error("HTML is too large to share (max about 400KB)");
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
