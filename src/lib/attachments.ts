import type { ChatAttachment } from "@/types/chat";
import { excelBufferToCsvText, isExcelFile } from "@/lib/excel";

export const MAX_CHAT_FILES = 5;
/** Raised so campaign report CSVs (multi‑MB) can upload. */
export const MAX_CHAT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 40_000;
/** Max chars kept in memory for tools (imports / dashboards). */
export const MAX_CSV_FULL_CHARS = 25 * 1024 * 1024;
/** What the model sees — never dump megabyte CSVs into the chat LLM. */
export const MAX_CSV_PROMPT_CHARS = 12_000;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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
  /** Compact text for the LLM (summaries for large CSVs). */
  text: string;
  /** Full file contents for tools (CSV import / dashboards). */
  fullText?: string;
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

function isCsvLike(name: string, type: string) {
  const ext = extOf(name);
  return ext === "csv" || ext === "tsv" || type.includes("csv") || type.includes("tab-separated");
}

function isSpreadsheetLike(name: string, type: string) {
  return isExcelFile(name, type) || isCsvLike(name, type);
}

/** Build a short LLM-facing summary so large CSVs do not blow the context window. */
export function summarizeCsvForPrompt(raw: string, name: string, byteSize: number) {
  const cleaned = raw.replace(/\u0000/g, "");
  const lines = cleaned.split(/\r?\n/).filter((line) => line.length > 0);
  const header = lines.find((line) => /email/i.test(line)) || lines[0] || "(no header)";
  const dataCount = Math.max(0, lines.length - 1);
  const headSample = lines.slice(0, 20).join("\n");
  const sizeMb = (byteSize / (1024 * 1024)).toFixed(1);
  const kind = isExcelFile(name) ? "Excel spreadsheet" : "CSV";

  const body = [
    `Large ${kind} attached: "${name}" (${sizeMb} MB, ~${dataCount.toLocaleString()} lines after conversion — approximate).`,
    `Header/sample columns: ${header}`,
    "",
    "First rows (sample):",
    headSample || "(empty)",
    "",
    "IMPORTANT: The full spreadsheet/CSV is available to tools only (not pasted here).",
    "For dashboards/reports: call share_csv_dashboard (uses the full attached file).",
    "For Attio import: call attio_import_to_list once (uses the full attached file).",
    "Do not ask the user to re-upload or paste the file. Do not invent rows.",
  ]
    .filter(Boolean)
    .join("\n");

  return clip(body, MAX_CSV_PROMPT_CHARS);
}

async function extractPdf(bytes: Uint8Array) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: true });
  const text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
  return clip(text || "");
}

function asSpreadsheetPayload(raw: string, meta: ChatAttachment) {
  const fullText =
    raw.length > MAX_CSV_FULL_CHARS
      ? `${raw.slice(0, MAX_CSV_FULL_CHARS)}\n…truncated for storage`
      : raw;
  const truncatedStorage = raw.length > MAX_CSV_FULL_CHARS;
  const summary = summarizeCsvForPrompt(fullText, meta.name, meta.size);
  return {
    meta,
    text: truncatedStorage
      ? `${summary}\n\nNote: file exceeded ${Math.round(MAX_CSV_FULL_CHARS / (1024 * 1024))}MB text cap; tools see a truncated copy.`
      : summary,
    fullText,
  } satisfies ExtractedFile;
}

export async function extractUploadedFile(file: File): Promise<ExtractedFile> {
  const meta: ChatAttachment = {
    name: file.name || "upload",
    type: file.type || "application/octet-stream",
    size: file.size,
  };

  if (file.size > MAX_CHAT_FILE_BYTES) {
    throw new Error(
      `${meta.name} is larger than ${Math.round(MAX_CHAT_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(meta.name);
  const imageMime =
    (meta.type.startsWith("image/") ? meta.type : "") || IMAGE_MIME[ext] || "";

  if (imageMime) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`${meta.name} is larger than 6MB. Compress the image and try again.`);
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

  if (isExcelFile(meta.name, meta.type)) {
    try {
      const csvText = await excelBufferToCsvText(bytes, meta.name);
      if (!csvText.trim()) {
        return { meta, text: `Excel file "${meta.name}" had no readable rows.` };
      }
      return asSpreadsheetPayload(csvText, {
        ...meta,
        type: "text/csv",
      });
    } catch (err) {
      throw new Error(
        `Could not read Excel ${meta.name}: ${err instanceof Error ? err.message : "failed"}`,
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
      text: `Binary file "${meta.name}" attached. Upload CSV, Excel (.xlsx/.xls), TXT, JSON, PDF, or an image so I can read the contents.`,
    };
  }

  const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!raw.trim()) {
    return { meta, text: `File "${meta.name}" was empty.` };
  }

  if (isSpreadsheetLike(meta.name, meta.type)) {
    return asSpreadsheetPayload(raw, meta);
  }

  return { meta, text: clip(raw, MAX_EXTRACTED_CHARS) };
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

export function toolFilePayload(files: ExtractedFile[]) {
  return files.map((item) => ({
    name: item.meta.name,
    text: item.fullText || item.text,
    summary: item.text,
  }));
}
