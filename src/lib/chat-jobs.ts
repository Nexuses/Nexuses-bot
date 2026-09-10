import { mkdir, writeFile, readFile, rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { dbConnect } from "@/lib/db";
import { ChatJob } from "@/models/ChatJob";
import { Message } from "@/models/Message";
import { Integration } from "@/models/Integration";
import { Chat } from "@/models/Chat";

export type ChatJobDTO = {
  _id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  title: string;
  chatId: string;
  progressDone: number;
  progressTotal: number;
  lastSummary: string;
  error: string;
  result: unknown;
  createdAt: string;
  finishedAt: string;
};

function payloadRoot() {
  return path.join(process.cwd(), ".data", "chat-jobs");
}

export function serializeChatJob(doc: {
  _id: unknown;
  type?: string;
  status: ChatJobDTO["status"];
  title: string;
  chatId: unknown;
  progressDone?: number;
  progressTotal?: number;
  lastSummary?: string;
  error?: string;
  result?: unknown;
  createdAt?: Date | string;
  finishedAt?: Date | string;
}): ChatJobDTO {
  return {
    _id: String(doc._id),
    type: doc.type || "attio_csv_import",
    status: doc.status,
    title: doc.title,
    chatId: String(doc.chatId),
    progressDone: Number(doc.progressDone || 0),
    progressTotal: Number(doc.progressTotal || 0),
    lastSummary: String(doc.lastSummary || ""),
    error: String(doc.error || ""),
    result: doc.result ?? null,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : "",
    finishedAt: doc.finishedAt ? new Date(doc.finishedAt).toISOString() : "",
  };
}

export async function enqueueAttioCsvImport(input: {
  userId: string;
  projectId: string;
  chatId: string;
  listName: string;
  csvText: string;
  args: Record<string, unknown>;
  totalRows: number;
}) {
  await dbConnect();
  const id = randomUUID();
  const dir = path.join(payloadRoot(), input.projectId);
  await mkdir(dir, { recursive: true });
  const payloadPath = path.join(dir, `${id}.csv`);
  await writeFile(payloadPath, input.csvText, "utf8");

  const job = await ChatJob.create({
    userId: input.userId,
    projectId: input.projectId,
    chatId: input.chatId,
    type: "attio_csv_import",
    status: "queued",
    title: `Import ${input.totalRows.toLocaleString()} contacts → Attio “${input.listName}”`,
    payloadPath,
    args: {
      ...input.args,
      list: input.listName,
    },
    progressDone: 0,
    progressTotal: input.totalRows,
    lastSummary: "Queued — will keep running until finished.",
    nextRunAt: new Date(),
  });

  ensureChatJobRunner();
  void processChatJobById(String(job._id));

  return serializeChatJob(job);
}

async function updateJob(id: string, patch: Record<string, unknown>) {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) clean[key] = value;
  }
  if (!Object.keys(clean).length) return;
  await ChatJob.findByIdAndUpdate(id, { $set: clean });
}

export async function processChatJobById(jobId: string) {
  await dbConnect();
  const job = await ChatJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ["queued", "running"] } },
    {
      $set: {
        status: "running",
        startedAt: new Date(),
        lastSummary: "Running…",
      },
    },
    { returnDocument: "after" },
  );
  if (!job) return null;

  // Prevent double-run: if already being processed by another worker with a lock,
  // we use a simple in-memory set.
  const g = globalThis as unknown as { __nexusesChatJobLocks?: Set<string> };
  if (!g.__nexusesChatJobLocks) g.__nexusesChatJobLocks = new Set();
  if (g.__nexusesChatJobLocks.has(jobId)) return serializeChatJob(job);
  g.__nexusesChatJobLocks.add(jobId);

  try {
    if (job.type === "attio_csv_import") {
      await runAttioCsvImportJob(job);
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Job failed";
    await updateJob(jobId, {
      status: "failed",
      error: message,
      lastSummary: message,
      finishedAt: new Date(),
    });
    await postJobMessage({
      userId: String(job.userId),
      projectId: String(job.projectId),
      chatId: String(job.chatId),
      content: `**Background import failed:** ${message}\n\nYou can re-attach the CSV and ask again — the job keeps running in the background next time until it finishes.`,
      toolsUsed: ["attio_import_to_list"],
      jobId,
    });
  } finally {
    g.__nexusesChatJobLocks.delete(jobId);
    if (job.payloadPath) {
      await rm(job.payloadPath, { force: true }).catch(() => undefined);
    }
  }

  const fresh = await ChatJob.findById(jobId).lean();
  return fresh ? serializeChatJob(fresh) : null;
}

async function runAttioCsvImportJob(job: {
  _id: unknown;
  userId: unknown;
  projectId: unknown;
  chatId: unknown;
  payloadPath?: string;
  args?: Record<string, unknown>;
  progressTotal?: number;
}) {
  const jobId = String(job._id);
  if (!job.payloadPath) throw new Error("Missing CSV payload");
  const csvText = await readFile(job.payloadPath, "utf8");
  const attio = await Integration.findOne({
    userId: job.userId,
    projectId: job.projectId,
    provider: "attio",
  }).lean();
  if (!attio?.apiKey) throw new Error("Attio is not connected");

  const { runAttioCsvImportFromText } = await import("@/lib/attio-import");
  const result = await runAttioCsvImportFromText({
    apiKey: attio.apiKey,
    args: (job.args || {}) as Record<string, unknown>,
    csvText,
    onStatus: async (text, done, total) => {
      await updateJob(jobId, {
        lastSummary: text,
        progressDone: done ?? undefined,
        progressTotal: total ?? undefined,
      });
    },
  });

  const stageNote = result.mapEngagement
    ? "staged by engagement"
    : result.stage
      ? `onto “${result.stage}”`
      : "";
  const content = [
    `**Import finished** — ${result.imported.toLocaleString()} contacts into **${result.list}**${stageNote ? ` (${stageNote})` : ""}.`,
    result.skipped ? `${result.skipped.toLocaleString()} skipped.` : "",
    result.truncated
      ? `File had ${result.totalInFile.toLocaleString()} rows; imported first ${result.importedCap.toLocaleString()}.`
      : "",
    result.errors?.length ? `Sample errors: ${result.errors.slice(0, 3).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const saved = await postJobMessage({
    userId: String(job.userId),
    projectId: String(job.projectId),
    chatId: String(job.chatId),
    content,
    toolsUsed: ["attio_import_to_list"],
    jobId,
  });

  await updateJob(jobId, {
    status: "completed",
    progressDone: result.imported + result.skipped,
    progressTotal: result.importedCap || result.totalInFile,
    lastSummary: `Imported ${result.imported} contacts`,
    result,
    error: "",
    finishedAt: new Date(),
    resultMessageId: saved?._id,
  });
}

async function postJobMessage(input: {
  userId: string;
  projectId: string;
  chatId: string;
  content: string;
  toolsUsed: string[];
  jobId: string;
}) {
  await dbConnect();
  const saved = await Message.create({
    userId: input.userId,
    projectId: input.projectId,
    chatId: input.chatId,
    role: "assistant",
    content: input.content,
    toolsUsed: input.toolsUsed,
  });
  await Chat.findByIdAndUpdate(input.chatId, { updatedAt: new Date() }).catch(() => undefined);
  return saved;
}

export async function processDueChatJobs(limit = 3) {
  await dbConnect();
  const due = await ChatJob.find({
    status: "queued",
    nextRunAt: { $lte: new Date() },
  })
    .sort({ nextRunAt: 1 })
    .limit(limit);

  const out: ChatJobDTO[] = [];
  for (const job of due) {
    const updated = await processChatJobById(String(job._id));
    if (updated) out.push(updated);
  }
  return out;
}

export function ensureChatJobRunner() {
  const g = globalThis as unknown as { __nexusesChatJobTimer?: NodeJS.Timeout };
  if (g.__nexusesChatJobTimer) return;
  g.__nexusesChatJobTimer = setInterval(() => {
    void processDueChatJobs().catch(() => undefined);
  }, 10_000);
  void processDueChatJobs().catch(() => undefined);
}

export async function listProjectChatJobs(input: {
  userId: string;
  projectId: string;
  chatId?: string;
  activeOnly?: boolean;
}) {
  await dbConnect();
  const filter: Record<string, unknown> = {
    userId: input.userId,
    projectId: input.projectId,
  };
  if (input.chatId) filter.chatId = input.chatId;
  if (input.activeOnly) filter.status = { $in: ["queued", "running"] };

  const docs = await ChatJob.find(filter).sort({ createdAt: -1 }).limit(20).lean();
  return docs.map((doc) => serializeChatJob(doc));
}
