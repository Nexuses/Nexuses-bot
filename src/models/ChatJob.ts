import { Schema, models, model } from "mongoose";

const ChatJobSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
    type: {
      type: String,
      enum: ["attio_csv_import", "brevo_to_attio"],
      default: "attio_csv_import",
    },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "stopped"],
      default: "queued",
      index: true,
    },
    title: { type: String, required: true, trim: true },
    /** Disk path to CSV payload (not stored in Mongo). */
    payloadPath: { type: String, default: "" },
    args: { type: Schema.Types.Mixed, default: {} },
    progressDone: { type: Number, default: 0 },
    progressTotal: { type: Number, default: 0 },
    lastSummary: { type: String, default: "" },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: "" },
    resultMessageId: { type: Schema.Types.ObjectId, ref: "Message" },
    nextRunAt: { type: Date, default: Date.now, index: true },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

ChatJobSchema.index({ projectId: 1, status: 1, nextRunAt: 1 });
ChatJobSchema.index({ chatId: 1, status: 1 });

export const ChatJob = models.ChatJob || model("ChatJob", ChatJobSchema);
