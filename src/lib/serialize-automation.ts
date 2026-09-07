export type AutomationDTO = {
  _id: string;
  type: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  title: string;
  sourceProvider: "lemlist" | "brevo";
  campaignName: string;
  attioList: string;
  stageOpen: string;
  stageClick: string;
  stageReply: string;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunAt: string;
  lastSummary: string;
  runCount: number;
  error: string;
};

export function serializeAutomation(doc: {
  _id: unknown;
  type?: string;
  status: AutomationDTO["status"];
  title: string;
  sourceProvider: AutomationDTO["sourceProvider"];
  campaignName: string;
  attioList: string;
  stageOpen?: string;
  stageClick?: string;
  stageReply?: string;
  intervalMinutes?: number;
  nextRunAt?: Date;
  lastRunAt?: Date;
  lastSummary?: string;
  runCount?: number;
  error?: string;
}): AutomationDTO {
  return {
    _id: String(doc._id),
    type: doc.type || "campaign_to_attio",
    status: doc.status,
    title: doc.title,
    sourceProvider: doc.sourceProvider,
    campaignName: doc.campaignName,
    attioList: doc.attioList,
    stageOpen: doc.stageOpen || "open",
    stageClick: doc.stageClick || "click",
    stageReply: doc.stageReply || "hot",
    intervalMinutes: doc.intervalMinutes || 2,
    nextRunAt: doc.nextRunAt ? new Date(doc.nextRunAt).toISOString() : "",
    lastRunAt: doc.lastRunAt ? new Date(doc.lastRunAt).toISOString() : "",
    lastSummary: doc.lastSummary || "",
    runCount: doc.runCount || 0,
    error: doc.error || "",
  };
}
