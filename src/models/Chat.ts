import { Schema, models, model } from "mongoose";

const ChatSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    title: { type: String, default: "New chat" },
  },
  { timestamps: true },
);

ChatSchema.index({ userId: 1, projectId: 1, updatedAt: -1 });

export const Chat = models.Chat || model("Chat", ChatSchema);
