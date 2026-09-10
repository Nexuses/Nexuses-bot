import { Schema, models, model } from "mongoose";

const HtmlDraftSchema = new Schema(
  {
    draftId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    title: { type: String, trim: true, default: "" },
    clientLogoUrl: { type: String, trim: true, default: "" },
    clientName: { type: String, trim: true, default: "" },
    buffer: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

HtmlDraftSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const HtmlDraft = models.HtmlDraft || model("HtmlDraft", HtmlDraftSchema);
