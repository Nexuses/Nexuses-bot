import { Schema, models, model } from "mongoose";

const HtmlShareSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", index: true },
    title: { type: String, trim: true, default: "Shared HTML" },
    html: { type: String, required: true },
  },
  { timestamps: true },
);

export const HtmlShare = models.HtmlShare || model("HtmlShare", HtmlShareSchema);
