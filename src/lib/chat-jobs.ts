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
  status: "queued" | "running" | "completed" | "failed" | "stopped";
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

export async function enqueueBrevoToAttioImport(input: {
  userId: string;
  projectId: string;
  chatId: string;
  campaigns: string[];
  attioList: string;
  stageProspect?: string;
  stageOpen?: string;
  stageClick?: string;
}) {
  await dbConnect();
  const job = await ChatJob.create({
    userId: input.userId,
    projectId: input.projectId,
    chatId: input.chatId,
    type: "brevo_to_attio",
    status: "queued",
    title: `Brevo → Attio “${input.attioList}” (${input.campaigns.length} campaigns)`,
    args: {
      campaigns: input.campaigns,
      attioList: input.attioList,
      stageProspect: input.stageProspect || "Prospect",
      stageOpen: input.stageOpen || "Open",
      stageClick: input.stageClick || "Click",
    },
    progressDone: 0,
    progressTotal: 0,
    lastSummary: "Queued — exporting Brevo recipients via API, then updating Attio.",
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
    } else if (job.type === "brevo_to_attio") {
      await runBrevoToAttioJob(job);
    } else {
      throw new Error(`Unknown job type: ${job.type}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Job failed";
    const stopped = /stopped by user/i.test(message);
    await updateJob(jobId, {
      status: stopped ? "stopped" : "failed",
      error: message,
      lastSummary: message,
      finishedAt: new Date(),
    });
    if (!stopped) {
      await postJobMessage({
        userId: String(job.userId),
        projectId: String(job.projectId),
        chatId: String(job.chatId),
        content: `**Background import failed:** ${message}\n\nAsk me to retry — the import runs via API in the background until it finishes.`,
        toolsUsed:
          job.type === "brevo_to_attio"
            ? ["brevo_import_campaigns_to_attio"]
            : ["attio_import_to_list"],
        jobId,
      });
    }
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
      if (isChatJobCancelled(jobId)) {
        throw new Error("Stopped by user");
      }
      await updateJob(jobId, {
        lastSummary: text,
        progressDone: done ?? undefined,
        progressTotal: total ?? undefined,
      });
    },
    shouldCancel: () => isChatJobCancelled(jobId),
  });

  if (isChatJobCancelled(jobId)) {
    await updateJob(jobId, {
      status: "stopped",
      lastSummary: "Stopped by user",
      error: "Stopped by user",
      finishedAt: new Date(),
    });
    return;
  }

  const stageNote = result.mapEngagement
    ? "staged by engagement"
    : result.stage
      ? `onto “${result.stage}”`
      : "";
  const byStage = result.byStage && typeof result.byStage === "object" ? result.byStage : {};
  const stageLines = Object.entries(byStage)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `- **${name}**: ${Number(count).toLocaleString()}`);
  const content = [
    `**Import finished** — ${result.imported.toLocaleString()} contacts into **${result.list}**${stageNote ? ` (${stageNote})` : ""}.`,
    stageLines.length ? stageLines.join("\n") : "",
    result.skipped ? `${result.skipped.toLocaleString()} skipped (will need retry if rate-limited).` : "",
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

async function runBrevoToAttioJob(job: {
  _id: unknown;
  userId: unknown;
  projectId: unknown;
  chatId: unknown;
  args?: Record<string, unknown>;
}) {
  const jobId = String(job._id);
  const args = (job.args || {}) as Record<string, unknown>;
  const campaigns = Array.isArray(args.campaigns)
    ? args.campaigns.map((c) => String(c || "").trim()).filter(Boolean)
    : [];
  const attioList = String(args.attioList || args.list || "").trim();
  if (!campaigns.length) throw new Error("No Brevo campaigns on this job");
  if (!attioList) throw new Error("Attio list missing on this job");

  const [attio, brevo] = await Promise.all([
    Integration.findOne({
      userId: job.userId,
      projectId: job.projectId,
      provider: "attio",
    }).lean(),
    Integration.findOne({
      userId: job.userId,
      projectId: job.projectId,
      provider: "brevo",
    }).lean(),
  ]);
  if (!attio?.apiKey) throw new Error("Attio is not connected");
  if (!brevo?.apiKey) throw new Error("Brevo is not connected");

  const { importBrevoCampaignsToAttio } = await import("@/lib/brevo-attio-import");
  const result = await importBrevoCampaignsToAttio({
    attioApiKey: attio.apiKey,
    brevoApiKey: brevo.apiKey,
    brevoRestApiKey: brevo.restApiKey || undefined,
    brevoMcpUrl: brevo.mcpUrl || undefined,
    campaigns,
    attioList,
    stageProspect: String(args.stageProspect || "Prospect"),
    stageOpen: String(args.stageOpen || "Open"),
    stageClick: String(args.stageClick || "Click"),
    onStatus: async (text, done, total) => {
      if (isChatJobCancelled(jobId)) throw new Error("Stopped by user");
      await updateJob(jobId, {
        lastSummary: text,
        progressDone: done ?? undefined,
        progressTotal: total ?? undefined,
      });
    },
    shouldCancel: () => isChatJobCancelled(jobId),
  });

  if (isChatJobCancelled(jobId)) {
    await updateJob(jobId, {
      status: "stopped",
      lastSummary: "Stopped by user",
      error: "Stopped by user",
      finishedAt: new Date(),
    });
    return;
  }

  const stageLines = Object.entries(result.byStage || {})
    .map(([stage, count]) => `- **${stage}:** ${Number(count).toLocaleString()}`)
    .join("\n");
  const skippedCampaigns = Array.isArray(result.campaignErrors)
    ? result.campaignErrors
    : [];
  const content = [
    `**Brevo → Attio finished** — **${result.imported.toLocaleString()}** unique contacts in **${result.list}**.`,
    stageLines,
    result.rawRecipientSum
      ? `Raw Brevo recipient sum across campaigns: ${result.rawRecipientSum.toLocaleString()} (overlap deduped in Attio).`
      : "",
    skippedCampaigns.length
      ? `Skipped campaigns (${skippedCampaigns.length}): ${skippedCampaigns.slice(0, 5).join(" | ")}`
      : "",
    result.skipped ? `${result.skipped.toLocaleString()} contacts skipped with errors.` : "",
    result.errors?.length && !skippedCampaigns.length
      ? `Sample errors: ${result.errors.slice(0, 3).join("; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const saved = await postJobMessage({
    userId: String(job.userId),
    projectId: String(job.projectId),
    chatId: String(job.chatId),
    content,
    toolsUsed: ["brevo_import_campaigns_to_attio"],
    jobId,
  });

  await updateJob(jobId, {
    status: "completed",
    progressDone: result.imported + result.skipped,
    progressTotal: result.uniquePeople,
    lastSummary: `Imported ${result.imported} contacts from Brevo`,
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

function cancelledJobIds() {
  const g = globalThis as unknown as { __nexusesCancelledChatJobs?: Set<string> };
  if (!g.__nexusesCancelledChatJobs) g.__nexusesCancelledChatJobs = new Set();
  return g.__nexusesCancelledChatJobs;
}

export function isChatJobCancelled(jobId: string) {
  return cancelledJobIds().has(jobId);
}

export async function stopProjectChatJobs(input: {
  userId: string;
  projectId: string;
  chatId?: string;
}) {
  await dbConnect();
  const filter: Record<string, unknown> = {
    userId: input.userId,
    projectId: input.projectId,
    status: { $in: ["queued", "running"] },
  };
  if (input.chatId) filter.chatId = input.chatId;

  const jobs = await ChatJob.find(filter).select("_id").lean();
  for (const job of jobs) {
    cancelledJobIds().add(String(job._id));
  }

  await ChatJob.updateMany(filter, {
    $set: {
      status: "stopped",
      lastSummary: "Stopped by user",
      error: "Stopped by user",
      finishedAt: new Date(),
    },
  });

  return { stopped: jobs.length };
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
