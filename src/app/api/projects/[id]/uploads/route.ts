import { jsonError } from "@/lib/api";
import {
  beginChunkedUpload,
  finishChunkedUpload,
  saveChatUpload,
  saveUploadChunk,
} from "@/lib/chat-uploads";
import { requireProjectMember } from "@/lib/project-access";

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 60;

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, project, error } = await requireProjectMember(id);
  if (error || !session || !project) return error ?? jsonError("Unauthorized", 401);

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonError("Expected multipart upload");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(
      "Upload failed — request too large for the server proxy. Use a smaller file or raise client_max_body_size / proxy body limits.",
      413,
    );
  }

  const mode = String(form.get("mode") || "single").trim();

  try {
    if (mode === "begin") {
      const name = String(form.get("name") || "upload");
      const type = String(form.get("type") || "application/octet-stream");
      const size = Number(form.get("size") || 0);
      const totalChunks = Number(form.get("totalChunks") || 0);
      const started = await beginChunkedUpload({
        userId: session.userId,
        projectId: id,
        name,
        type,
        size,
        totalChunks,
      });
      return Response.json({ upload: started });
    }

    if (mode === "chunk") {
      const uploadId = String(form.get("uploadId") || "").trim();
      const chunkIndex = Number(form.get("chunkIndex"));
      const chunk = form.get("chunk");
      if (!uploadId) return jsonError("uploadId is required");
      if (!Number.isFinite(chunkIndex)) return jsonError("chunkIndex is required");
      if (typeof chunk !== "object" || chunk === null || typeof (chunk as Blob).arrayBuffer !== "function") {
        return jsonError("chunk is required");
      }
      await saveUploadChunk({
        userId: session.userId,
        projectId: id,
        uploadId,
        chunkIndex,
        chunk: chunk as Blob,
      });
      return Response.json({ ok: true, chunkIndex });
    }

    if (mode === "finish") {
      const uploadId = String(form.get("uploadId") || "").trim();
      if (!uploadId) return jsonError("uploadId is required");
      const upload = await finishChunkedUpload({
        userId: session.userId,
        projectId: id,
        uploadId,
      });
      return Response.json({ upload });
    }

    const item = form.get("file");
    if (typeof item !== "object" || item === null || typeof (item as File).arrayBuffer !== "function") {
      return jsonError("file is required");
    }
    const file = item as File;
    if (!file.size) return jsonError("File was empty");
    const upload = await saveChatUpload({
      userId: session.userId,
      projectId: id,
      file,
    });
    return Response.json({ upload });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Upload failed", 400);
  }
}
