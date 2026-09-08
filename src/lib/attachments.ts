import type { ChatAttachment } from "@/types/chat";

export const MAX_CHAT_FILES = 5;
export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 40_000;
export const MAX_CSV_CHARS = 400_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const TEXT_EXT = new Set([
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "htm",
  "log",
  "yml",
  "yaml",
  "ics",
  "vcf",
]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export type ExtractedImage = {
  mime: string;
  base64: string;
};

export type ExtractedFile = {
  meta: ChatAttachment;
  text: string;
  image?: ExtractedImage;
};

function clip(text: string, max = MAX_EXTRACTED_CHARS) {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}\n\n…truncated`;
}

function extOf(name: string) {
  return name.split(".").pop()?.toLowerCase() || "";
}

async function extractPdf(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  return clip(text || "");
}

export async function extractUploadedFile(file: File): Promise<ExtractedFile> {
  const meta: ChatAttachment = {
    name: file.name || "upload",
    type: file.type || "application/octet-stream",
    size: file.size,
  };

  if (file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error(`${meta.name} is larger than 8MB`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(meta.name);
  const imageMime =
    (meta.type.startsWith("image/") ? meta.type : "") || IMAGE_MIME[ext] || "";

  if (imageMime) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`${meta.name} is larger than 4MB. Compress the image and try again.`);
    }
    return {
      meta: { ...meta, type: imageMime },
      text: `Image attached: ${meta.name}. Look at this image (screenshot/photo) and use what you see — including any text, tables, UI labels, emails, and numbers — to answer the user.`,
      image: {
        mime: imageMime,
        base64: Buffer.from(bytes).toString("base64"),
      },
    };
  }

  if (ext === "pdf" || meta.type === "application/pdf") {
    try {
      const text = await extractPdf(bytes);
      if (!text) {
        return { meta, text: `PDF "${meta.name}" had no extractable text.` };
      }
      return { meta, text };
    } catch (err) {
      throw new Error(
        `Could not read PDF ${meta.name}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }

  const looksText =
    TEXT_EXT.has(ext) ||
    meta.type.startsWith("text/") ||
    meta.type.includes("json") ||
    meta.type.includes("xml") ||
    meta.type.includes("csv");

  const sample = bytes.slice(0, 1024);
  const hasNull = sample.includes(0);
  if (!looksText && hasNull) {
    return {
      meta,
      text: `Binary file "${meta.name}" attached. Upload CSV, TXT, JSON, PDF, or an image so I can read the contents.`,
    };
  }

  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const limit = ext === "csv" || ext === "tsv" || meta.type.includes("csv") ? MAX_CSV_CHARS : MAX_EXTRACTED_CHARS;
  return { meta, text: clip(raw, limit) || `File "${meta.name}" was empty.` };
}

export function buildFilePrompt(message: string, files: ExtractedFile[]) {
  if (!files.length) return message;
  const blocks = files.map((file) => {
    if (file.image) {
      return `### ${file.meta.name}\nType: ${file.meta.type || "image"} · ${file.meta.size} bytes\n\n${file.text}`;
    }
    return `### ${file.meta.name}\nType: ${file.meta.type || "unknown"} · ${file.meta.size} bytes\n\n${file.text}`;
  });
  return `${message}\n\nAttached files (use this data to complete the request):\n\n${blocks.join("\n\n")}`;
}
