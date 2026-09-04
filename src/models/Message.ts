import { Schema, models, model } from "mongoose";

const MessageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    toolsUsed: [{ type: String }],
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", index: true },
    attachments: [
      {
        name: { type: String, required: true },
        type: { type: String, default: "" },
        size: { type: Number, default: 0 },
        _id: false,
      },
    ],
  },
  { timestamps: true },
);

MessageSchema.index({ userId: 1, projectId: 1, createdAt: 1 });
MessageSchema.index({ chatId: 1, createdAt: 1 });

export const Message = models.Message || model("Message", MessageSchema);
