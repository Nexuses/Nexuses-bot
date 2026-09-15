import { mkdir, readFile, writeFile, rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { MAX_CHAT_FILE_BYTES } from "@/lib/attachments";

export type StoredUploadMeta = {
  id: string;
  userId: string;
  projectId: string;
  chatId?: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
  /** ISO expiry — uploads are kept across chat turns until this time. */
  expiresAt?: string;
};

const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000;

function rootDir() {
  return path.join(process.cwd(), ".data", "chat-uploads");
}

function uploadDir(projectId: string, uploadId: string) {
  return path.join(rootDir(), projectId, uploadId);
}

function defaultExpiresAt(from = new Date()) {
  return new Date(from.getTime() + UPLOAD_TTL_MS).toISOString();
}

export async function beginChunkedUpload(input: {
  userId: string;
  projectId: string;
  name: string;
  type: string;
  size: number;
  totalChunks: number;
}): Promise<{ id: string }> {
  if (input.size > MAX_CHAT_FILE_BYTES) {
    throw new Error(
      `${input.name || "File"} is larger than ${Math.round(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  if (input.totalChunks < 1 || input.totalChunks > 200) {
    throw new Error("Invalid chunk count");
  }
  const id = randomUUID();
  const dir = uploadDir(input.projectId, id);
  await mkdir(path.join(dir, "chunks"), { recursive: true });
  const meta = {
    id,
    userId: input.userId,
    projectId: input.projectId,
    name: input.name || "upload",
    type: input.type || "application/octet-stream",
    size: input.size,
    totalChunks: input.totalChunks,
    createdAt: new Date().toISOString(),
    expiresAt: defaultExpiresAt(),
    incomplete: true,
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return { id };
}

export async function saveUploadChunk(input: {
  userId: string;
  projectId: string;
  uploadId: string;
  chunkIndex: number;
  chunk: File | Blob;
}) {
  const dir = uploadDir(input.projectId, input.uploadId);
  let rawMeta: string;
  try {
    rawMeta = await readFile(path.join(dir, "meta.json"), "utf8");
  } catch {
    throw new Error("Upload session not found. Re-attach the file.");
  }
  const meta = JSON.parse(rawMeta) as StoredUploadMeta & {
    totalChunks?: number;
    incomplete?: boolean;
  };
  if (meta.userId !== input.userId || meta.projectId !== input.projectId) {
    throw new Error("Upload session not found. Re-attach the file.");
  }
  const total = Number(meta.totalChunks || 0);
  if (input.chunkIndex < 0 || input.chunkIndex >= total) {
    throw new Error("Invalid chunk index");
  }
  const bytes = Buffer.from(await input.chunk.arrayBuffer());
  await writeFile(path.join(dir, "chunks", `${input.chunkIndex}.part`), bytes);
  return { ok: true, chunkIndex: input.chunkIndex };
}

export async function finishChunkedUpload(input: {
  userId: string;
  projectId: string;
  uploadId: string;
}): Promise<StoredUploadMeta> {
  const dir = uploadDir(input.projectId, input.uploadId);
  let rawMeta: string;
  try {
    rawMeta = await readFile(path.join(dir, "meta.json"), "utf8");
  } catch {
    throw new Error("Upload session not found. Re-attach the file.");
  }
  const meta = JSON.parse(rawMeta) as StoredUploadMeta & {
    totalChunks?: number;
    incomplete?: boolean;
  };
  if (meta.userId !== input.userId || meta.projectId !== input.projectId) {
    throw new Error("Upload session not found. Re-attach the file.");
  }
  const total = Number(meta.totalChunks || 0);
  const parts: Buffer[] = [];
  let totalSize = 0;
  for (let i = 0; i < total; i += 1) {
    try {
      const part = await readFile(path.join(dir, "chunks", `${i}.part`));
      parts.push(part);
      totalSize += part.length;
    } catch {
      throw new Error(`Missing chunk ${i + 1} of ${total}. Re-attach the file.`);
    }
  }
  if (totalSize > MAX_CHAT_FILE_BYTES) {
    await deleteChatUpload(input.projectId, input.uploadId);
    throw new Error(
      `File is larger than ${Math.round(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const assembled = Buffer.concat(parts);
  await writeFile(path.join(dir, "file"), assembled);
  await rm(path.join(dir, "chunks"), { recursive: true, force: true }).catch(() => undefined);
  const finalMeta: StoredUploadMeta = {
    id: meta.id,
    userId: meta.userId,
    projectId: meta.projectId,
    chatId: meta.chatId,
    name: meta.name,
    type: meta.type,
    size: assembled.length,
    createdAt: meta.createdAt,
    expiresAt: meta.expiresAt || defaultExpiresAt(),
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(finalMeta));
  return finalMeta;
}

export async function saveChatUpload(input: {
  userId: string;
  projectId: string;
  file: File;
  chatId?: string;
}): Promise<StoredUploadMeta> {
  if (input.file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error(
      `${input.file.name || "File"} is larger than ${Math.round(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const id = randomUUID();
  const dir = uploadDir(input.projectId, id);
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.from(await input.file.arrayBuffer());
  const meta: StoredUploadMeta = {
    id,
    userId: input.userId,
    projectId: input.projectId,
    chatId: input.chatId || undefined,
    name: input.file.name || "upload",
    type: input.file.type || "application/octet-stream",
    size: input.file.size,
    createdAt: new Date().toISOString(),
    expiresAt: defaultExpiresAt(),
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  await writeFile(path.join(dir, "file"), bytes);
  return meta;
}

export async function bindChatUpload(input: {
  userId: string;
  projectId: string;
  uploadId: string;
  chatId: string;
}): Promise<StoredUploadMeta | null> {
  const dir = uploadDir(input.projectId, input.uploadId);
  let rawMeta: string;
  try {
    rawMeta = await readFile(path.join(dir, "meta.json"), "utf8");
  } catch {
    return null;
  }
  const meta = JSON.parse(rawMeta) as StoredUploadMeta & { incomplete?: boolean };
  if (meta.userId !== input.userId || meta.projectId !== input.projectId || meta.incomplete) {
    return null;
  }
  meta.chatId = input.chatId;
  meta.expiresAt = defaultExpiresAt();
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

export async function loadChatUploadFile(input: {
  userId: string;
  projectId: string;
  uploadId: string;
}): Promise<{ meta: StoredUploadMeta; file: File }> {
  const dir = uploadDir(input.projectId, input.uploadId);
  let rawMeta: string;
  try {
    rawMeta = await readFile(path.join(dir, "meta.json"), "utf8");
  } catch {
    throw new Error("Upload not found or expired. Re-attach the file and try again.");
  }
  const meta = JSON.parse(rawMeta) as StoredUploadMeta & { incomplete?: boolean };
  if (meta.userId !== input.userId || meta.projectId !== input.projectId || meta.incomplete) {
    throw new Error("Upload not found or expired. Re-attach the file and try again.");
  }
  if (meta.expiresAt && Date.parse(meta.expiresAt) < Date.now()) {
    await deleteChatUpload(input.projectId, input.uploadId);
    throw new Error("Upload not found or expired. Re-attach the file and try again.");
  }
  const bytes = await readFile(path.join(dir, "file"));
  const file = new File([bytes], meta.name, { type: meta.type });
  return { meta, file };
}

/** Reload spreadsheets previously uploaded in this chat (so follow-ups don't re-ask). */
export async function loadRecentChatUploads(input: {
  userId: string;
  projectId: string;
  chatId: string;
  uploadIds?: string[];
}): Promise<Array<{ meta: StoredUploadMeta; file: File }>> {
  const ids = [...new Set((input.uploadIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  const loaded: Array<{ meta: StoredUploadMeta; file: File }> = [];
  for (const uploadId of ids) {
    try {
      const item = await loadChatUploadFile({
        userId: input.userId,
        projectId: input.projectId,
        uploadId,
      });
      if (item.meta.chatId && item.meta.chatId !== input.chatId) continue;
      loaded.push(item);
    } catch {
      // expired / missing
    }
  }
  return loaded;
}

export async function deleteChatUpload(projectId: string, uploadId: string) {
  try {
    await rm(uploadDir(projectId, uploadId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
