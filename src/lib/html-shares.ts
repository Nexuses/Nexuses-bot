import { randomBytes } from "crypto";
import { dbConnect } from "@/lib/db";
import { enhanceSharedHtml } from "@/lib/html-dashboard-kit";
import { HtmlShare } from "@/models/HtmlShare";

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

export async function createHtmlShare(input: {
  userId: string;
  projectId?: string;
  html: string;
  title?: string;
  origin?: string;
}) {
  await dbConnect();
  const raw = normalizeSharedHtml(input.html);
  const title = (input.title || "Shared HTML").trim().slice(0, 120) || "Shared HTML";
  const html = enhanceSharedHtml(raw, title);
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
