import { mkdir, readFile, writeFile, rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { MAX_CHAT_FILE_BYTES } from "@/lib/attachments";

export type StoredUploadMeta = {
  id: string;
  userId: string;
  projectId: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
};

function rootDir() {
  return path.join(process.cwd(), ".data", "chat-uploads");
}

function uploadDir(projectId: string, uploadId: string) {
  return path.join(rootDir(), projectId, uploadId);
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
    name: meta.name,
    type: meta.type,
    size: assembled.length,
    createdAt: meta.createdAt,
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(finalMeta));
  return finalMeta;
}

export async function saveChatUpload(input: {
  userId: string;
  projectId: string;
  file: File;
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
    name: input.file.name || "upload",
    type: input.file.type || "application/octet-stream",
    size: input.file.size,
    createdAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  await writeFile(path.join(dir, "file"), bytes);
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
  const bytes = await readFile(path.join(dir, "file"));
  const file = new File([bytes], meta.name, { type: meta.type });
  return { meta, file };
}

export async function deleteChatUpload(projectId: string, uploadId: string) {
  try {
    await rm(uploadDir(projectId, uploadId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}
