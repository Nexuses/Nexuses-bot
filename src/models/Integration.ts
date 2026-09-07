import { Schema, models, model } from "mongoose";

const IntegrationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    provider: {
      type: String,
      enum: ["attio", "brevo", "lemlist", "notion", "other"],
      required: true,
    },
    name: { type: String, required: true, trim: true },
    apiKey: { type: String, required: true },
    /** Classic Brevo REST API key when apiKey is an MCP-only token. */
    restApiKey: { type: String, default: "" },
    baseUrl: { type: String, trim: true, default: "" },
    mcpUrl: { type: String, trim: true, default: "" },
    authType: {
      type: String,
      enum: ["bearer", "api-key", "basic", "query"],
      default: "bearer",
    },
  },
  { timestamps: true },
);

IntegrationSchema.index({ userId: 1, projectId: 1, provider: 1, name: 1 }, { unique: true });

export const Integration = models.Integration || model("Integration", IntegrationSchema);
