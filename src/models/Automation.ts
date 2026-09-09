import { Schema, models, model } from "mongoose";

const AutomationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    type: {
      type: String,
      enum: ["campaign_to_attio"],
      default: "campaign_to_attio",
    },
    status: {
      type: String,
      enum: ["running", "paused", "completed", "failed", "stopped"],
      default: "running",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    sourceProvider: {
      type: String,
      enum: ["lemlist", "brevo", "other"],
      required: true,
    },
    /** Display / lookup name for custom (`other`) integrations. */
    sourceIntegrationName: { type: String, default: "", trim: true },
    campaignName: { type: String, required: true, trim: true },
    attioList: { type: String, required: true, trim: true },
    stageOpen: { type: String, default: "open" },
    stageClick: { type: String, default: "click" },
    stageReply: { type: String, default: "hot" },
    intervalMinutes: { type: Number, default: 2, min: 1, max: 60 },
    /** Poll recipe for custom / other connectors. */
    recipe: { type: Schema.Types.Mixed, default: undefined },
    nextRunAt: { type: Date, default: Date.now, index: true },
    lastRunAt: { type: Date },
    lastSummary: { type: String, default: "" },
    runCount: { type: Number, default: 0 },
    error: { type: String, default: "" },
  },
  { timestamps: true },
);

AutomationSchema.index({ projectId: 1, status: 1, nextRunAt: 1 });

export const Automation = models.Automation || model("Automation", AutomationSchema);
