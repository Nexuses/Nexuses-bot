"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { ChatSidebar } from "@/components/ChatSidebar";
import { IntegrationsPanel } from "@/components/IntegrationsPanel";
import { AutomationsPanel } from "@/components/AutomationsPanel";
import type { AutomationDTO } from "@/lib/serialize-automation";
import type { ChatAttachment, ChatMessageDTO, ChatThreadDTO, IntegrationDTO } from "@/types/chat";
import type { ProjectDTO, SessionUser } from "@/types";

const ACCEPT =
  ".pdf,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.log,.yml,.yaml,.png,.jpg,.jpeg,.webp,.gif";
const MAX_FILES = 5;
const MAX_BYTES = 32 * 1024 * 1024;

type PendingFile = {
  id: string;
  file: File;
  preview?: string;
};

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ChatEvent = {
  type?: string;
  text?: string;
  error?: string;
  message?: ChatMessageDTO;
  userMessage?: ChatMessageDTO;
  chat?: ChatThreadDTO;
  integrations?: IntegrationDTO[];
};

async function readChatEvents(res: Response, onEvent: (event: ChatEvent) => void) {
  if (!res.body) throw new Error("Empty response");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)) as ChatEvent);
      } catch {
        // Ignore a partial or malformed SSE frame.
      }
    }
  }
  if (buffer.trim()) {
    const line = buffer.split("\n").find((item) => item.startsWith("data: "));
    if (line) {
      try {
        onEvent(JSON.parse(line.slice(6)) as ChatEvent);
      } catch {
        // Ignore a trailing malformed SSE frame.
      }
    }
  }
}

function FileChips({
  items,
  onRemove,
  tone = "light",
}: {
  items: ChatAttachment[];
  onRemove?: (index: number) => void;
  tone?: "light" | "dark";
}) {
  if (!items.length) return null;
  const chip =
    tone === "dark"
      ? "border-white/25 bg-white/10 text-on-sea"
      : "border-line bg-ink-2 text-paper";
  const muted = tone === "dark" ? "text-on-sea/70" : "text-muted";
  return (
    <ul className="mb-3 flex flex-wrap gap-2">
      {items.map((item, index) => (
        <li
          key={`${item.name}-${index}`}
          className={`flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${chip}`}
        >
          <span className="truncate">{item.name}</span>
          <span className={muted}>{formatSize(item.size)}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(index)}
              className={muted}
              aria-label={`Remove ${item.name}`}
            >
              ×
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ProjectChat({
  user,
  project,
  projects,
  initialMessages,
  initialIntegrations,
  initialChats,
  initialChatId,
}: {
  user: SessionUser;
  project: ProjectDTO;
  projects: ProjectDTO[];
  initialMessages: ChatMessageDTO[];
  initialIntegrations: IntegrationDTO[];
  initialChats: ChatThreadDTO[];
  initialChatId: string;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [integrations, setIntegrations] = useState(initialIntegrations);
  const [chats, setChats] = useState(initialChats);
  const [activeChatId, setActiveChatId] = useState(initialChatId);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [automations, setAutomations] = useState<AutomationDTO[]>([]);
  const [stoppingId, setStoppingId] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const oauthError = params.get("oauth_error");
    if (!connected && !oauthError) return;

    if (connected) {
      void fetch(`/api/projects/${project._id}/integrations`)
        .then((res) => res.json())
        .then((data) => {
          if (Array.isArray(data.integrations)) setIntegrations(data.integrations);
        })
        .catch(() => {});
    }
    if (oauthError) setError(oauthError);

    params.delete("connected");
    params.delete("oauth_error");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
  }, [project._id]);

  async function refreshAutomations() {
    try {
      const res = await fetch(`/api/projects/${project._id}/automations`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.automations)) {
        setAutomations(data.automations);
      }
    } catch {
      // ignore poll errors
    }
  }

  useEffect(() => {
    void refreshAutomations();
    const timer = setInterval(
      () => void refreshAutomations(),
      automationsOpen ? 5_000 : 15_000,
    );
    return () => clearInterval(timer);
  }, [project._id, automationsOpen]);

  useEffect(() => {
    if (!busy) void refreshAutomations();
  }, [busy, project._id]);

  const runningAutomations = automations.filter((item) => item.status === "running");

  async function stopRunningAutomation(item: AutomationDTO) {
    setStoppingId(item._id);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project._id}/automations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", automationId: item._id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not stop automation");
      await refreshAutomations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop automation");
    } finally {
      setStoppingId("");
    }
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy, status]);

  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => {
    return () => {
      filesRef.current.forEach((item) => {
        if (item.preview) URL.revokeObjectURL(item.preview);
      });
    };
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  function setChatUrl(chatId: string) {
    const path = `/dashboard/${project._id}${chatId ? `?chat=${chatId}` : ""}`;
    router.replace(path, { scroll: false });
  }

  async function selectChat(id: string) {
    if (id === activeChatId || busy) return;
    setError("");
    setSidebarOpen(false);
    const res = await fetch(`/api/projects/${project._id}/messages?chatId=${id}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not open chat");
      return;
    }
    setActiveChatId(id);
    setMessages(data.messages ?? []);
    setChatUrl(id);
  }

  async function newChat() {
    if (busy) return;
    const current = chats.find((item) => item._id === activeChatId);
    if (current && messages.length === 0 && current.title === "New chat") {
      setSidebarOpen(false);
      return;
    }
    const res = await fetch(`/api/projects/${project._id}/chats`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not create chat");
      return;
    }
    setChats((list) => [data.chat, ...list.filter((item) => item._id !== data.chat._id)]);
    setActiveChatId(data.chat._id);
    setMessages([]);
    setInput("");
    setError("");
    setSidebarOpen(false);
    setChatUrl(data.chat._id);
  }

  async function deleteChat(id: string) {
    const res = await fetch(`/api/projects/${project._id}/chats/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    const remaining = chats.filter((item) => item._id !== id);
    setChats(remaining);
    if (id !== activeChatId) return;
    if (remaining[0]) {
      await selectChat(remaining[0]._id);
      return;
    }
    setActiveChatId("");
    setMessages([]);
    setChatUrl("");
  }

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    setError("");
    setFiles((current) => {
      const next = [...current];
      for (const file of incoming) {
        if (next.length >= MAX_FILES) {
          setError(`You can attach up to ${MAX_FILES} files`);
          break;
        }
        if (file.size > MAX_BYTES) {
          setError(`${file.name} is larger than 32MB`);
          continue;
        }
        const duplicate = next.some(
          (item) => item.file.name === file.name && item.file.size === file.size,
        );
        if (duplicate) continue;
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}`,
          file,
          preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        });
      }
      return next;
    });
  }

  function removeFile(index: number) {
    setFiles((current) => {
      const item = current[index];
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter((_, i) => i !== index);
    });
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  }

  async function uploadPendingFile(file: File, onProgress: (label: string) => void) {
    const CHUNK = 512 * 1024; // stay under common 1MB proxy limits
    if (file.size <= CHUNK) {
      const uploadForm = new FormData();
      uploadForm.set("file", file);
      const uploadRes = await fetch(`/api/projects/${project._id}/uploads`, {
        method: "POST",
        body: uploadForm,
      });
      const uploadData = (await uploadRes.json().catch(() => null)) as
        | { upload?: { id?: string }; error?: string }
        | null;
      if (!uploadRes.ok || !uploadData?.upload?.id) {
        throw new Error(
          uploadData?.error ||
            `Upload failed${uploadRes.status ? ` (${uploadRes.status})` : ""}.`,
        );
      }
      return uploadData.upload.id;
    }

    const totalChunks = Math.ceil(file.size / CHUNK);
    const beginForm = new FormData();
    beginForm.set("mode", "begin");
    beginForm.set("name", file.name);
    beginForm.set("type", file.type || "application/octet-stream");
    beginForm.set("size", String(file.size));
    beginForm.set("totalChunks", String(totalChunks));
    const beginRes = await fetch(`/api/projects/${project._id}/uploads`, {
      method: "POST",
      body: beginForm,
    });
    const beginData = (await beginRes.json().catch(() => null)) as
      | { upload?: { id?: string }; error?: string }
      | null;
    if (!beginRes.ok || !beginData?.upload?.id) {
      throw new Error(beginData?.error || `Could not start upload (${beginRes.status})`);
    }
    const uploadId = beginData.upload.id;

    for (let i = 0; i < totalChunks; i += 1) {
      onProgress(`Uploading ${file.name}… ${i + 1}/${totalChunks}`);
      const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
      const chunkForm = new FormData();
      chunkForm.set("mode", "chunk");
      chunkForm.set("uploadId", uploadId);
      chunkForm.set("chunkIndex", String(i));
      chunkForm.set("chunk", blob, `chunk-${i}`);
      const chunkRes = await fetch(`/api/projects/${project._id}/uploads`, {
        method: "POST",
        body: chunkForm,
      });
      const chunkData = (await chunkRes.json().catch(() => null)) as { error?: string } | null;
      if (!chunkRes.ok) {
        throw new Error(chunkData?.error || `Chunk upload failed (${chunkRes.status})`);
      }
    }

    const finishForm = new FormData();
    finishForm.set("mode", "finish");
    finishForm.set("uploadId", uploadId);
    const finishRes = await fetch(`/api/projects/${project._id}/uploads`, {
      method: "POST",
      body: finishForm,
    });
    const finishData = (await finishRes.json().catch(() => null)) as
      | { upload?: { id?: string }; error?: string }
      | null;
    if (!finishRes.ok || !finishData?.upload?.id) {
      throw new Error(finishData?.error || `Could not finish upload (${finishRes.status})`);
    }
    return finishData.upload.id;
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if ((!text && !files.length) || busy) return;
    setError("");
    const pending = files;
    const attachments = pending.map((item) => ({
      name: item.file.name,
      type: item.file.type,
      size: item.file.size,
    }));
    const optimistic: ChatMessageDTO = {
      _id: `local-${Date.now()}`,
      role: "user",
      content: text || (attachments.length === 1 ? `Uploaded ${attachments[0].name}` : `Uploaded ${attachments.length} files`),
      toolsUsed: [],
      attachments,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setFiles([]);
    setBusy(true);
    setStatus(pending.length ? "Uploading your file…" : "Working on it…");

    try {
      const uploadIds: string[] = [];
      for (const [index, item] of pending.entries()) {
        const id = await uploadPendingFile(item.file, (label) => {
          setStatus(
            pending.length === 1
              ? label
              : `File ${index + 1}/${pending.length}: ${label}`,
          );
        });
        uploadIds.push(id);
      }

      setStatus(pending.length ? "Reading your file…" : "Working on it…");
      const form = new FormData();
      form.set("message", text);
      if (activeChatId) form.set("chatId", activeChatId);
      if (uploadIds.length) form.set("uploadIds", JSON.stringify(uploadIds));

      const res = await fetch(`/api/projects/${project._id}/chat`, {
        method: "POST",
        body: form,
      });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok && !contentType.includes("text/event-stream")) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          data?.error || `Chat failed${res.status ? ` (${res.status})` : ""}`,
        );
      }

      let doneMessage: ChatMessageDTO | undefined;
      let doneUserMessage: ChatMessageDTO | undefined;
      let doneChat: ChatThreadDTO | undefined;
      let streamError = "";

      await readChatEvents(res, (event) => {
        if (event.type === "status" && event.text) setStatus(event.text);
        if (event.type === "integrations" && event.integrations) {
          setIntegrations(event.integrations);
        }
        if (event.type === "done") {
          doneMessage = event.message;
          doneUserMessage = event.userMessage;
          doneChat = event.chat;
          if (event.integrations) setIntegrations(event.integrations);
        }
        if (event.type === "error") streamError = event.error || "Chat failed";
      });

      if (streamError || !doneMessage) {
        throw new Error(
          streamError ||
            "Chat failed — the server closed the connection before finishing. For big Attio imports, try again; progress may still have applied.",
        );
      }

      pending.forEach((item) => {
        if (item.preview) URL.revokeObjectURL(item.preview);
      });
      const assistant = doneMessage;
      const savedUser = doneUserMessage;
      setMessages((current) => [
        ...current.map((item) =>
          item._id === optimistic._id && savedUser ? savedUser : item,
        ),
        assistant,
      ]);
      if (doneChat) {
        const chat = doneChat;
        setActiveChatId(chat._id);
        setChats((list) => [chat, ...list.filter((item) => item._id !== chat._id)]);
        setChatUrl(chat._id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
      setInput(text);
      setFiles(pending);
      setMessages((current) => current.filter((item) => item._id !== optimistic._id));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-ink">
      <ChatSidebar
        user={user}
        project={project}
        projects={projects}
        chats={chats}
        activeChatId={activeChatId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => void selectChat(id)}
        onNew={() => void newChat()}
        onDelete={(id) => void deleteChat(id)}
        onSwitchProject={(id) => router.push(`/dashboard/${id}`)}
        onLogout={() => void logout()}
      />
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-16 shrink-0 items-center border-b border-line">
        <div className="flex w-full items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg border border-line px-2 py-1 text-sm text-muted md:hidden"
              aria-label="Open chats"
            >
              Chats
            </button>
            <div className="min-w-0">
              <p className="truncate font-display text-lg tracking-tight">
                {chats.find((item) => item._id === activeChatId)?.title || "New chat"}
              </p>
              <p className="truncate text-xs text-muted">{project.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              className="rounded-full border border-line px-4 py-2 text-sm text-sea hover:border-sea"
            >
              Integrations
              {integrations.length ? ` · ${integrations.length}` : ""}
            </button>
            <button
              type="button"
              onClick={() => {
                void refreshAutomations();
                setAutomationsOpen(true);
              }}
              className={`relative rounded-full border px-4 py-2 text-sm hover:border-sea ${
                runningAutomations.length
                  ? "border-sea/50 bg-sea/10 text-sea"
                  : "border-line text-sea"
              }`}
              title={
                runningAutomations.length
                  ? `${runningAutomations.length} automation${runningAutomations.length === 1 ? "" : "s"} running — open to manage`
                  : "Automations"
              }
            >
              Automations
              {runningAutomations.length ? (
                <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-sea/20 px-2 py-0.5 text-[11px] font-medium leading-none text-sea">
                  <span
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sea"
                    aria-hidden
                  />
                  {runningAutomations.length} live
                </span>
              ) : automations.length ? (
                <span className="ml-1 text-muted">· {automations.length}</span>
              ) : null}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden px-4 sm:px-6">
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-8">
          <div className="space-y-5">
          {messages.length === 0 && !busy ? (
            <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
              <img
                src={project.logo}
                alt={project.name}
                referrerPolicy="no-referrer"
                className="mb-6 h-16 w-auto max-w-[220px] object-contain"
              />
              <h1 className="font-display text-4xl tracking-tight">Ask Nexuses.</h1>
              <p className="mt-3 max-w-md text-muted">
                Tell me what to do, or attach a CSV, PDF, text file, or screenshot. I will read it
                and finish the task.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {[
                  "Connect Attio with this API key",
                  "Create an Attio list named Nexuses bot with stages prospect, open, click, hot",
                  "Find a contact",
                  "What can you do?",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setInput(prompt);
                    }}
                    className="rounded-full border border-line px-4 py-2 text-sm text-muted hover:border-sea hover:text-paper"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <article
                key={message._id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`rounded-3xl px-5 py-4 ${
                    message.role === "user"
                      ? "max-w-[85%] bg-sea text-on-sea leading-7"
                      : "w-full max-w-full overflow-hidden border border-line bg-panel text-paper"
                  }`}
                >
                  {message.attachments?.length ? (
                    <FileChips
                      items={message.attachments}
                      tone={message.role === "user" ? "dark" : "light"}
                    />
                  ) : null}
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  ) : (
                    <ChatMarkdown
                      content={message.content}
                      projectId={project._id}
                      clientLogoUrl={project.logo}
                      clientName={project.name}
                    />
                  )}
                </div>
              </article>
            ))
          )}
          {busy ? (
            <div className="flex items-center gap-1.5 text-sm text-muted">
              <img
                src="https://nexuseslink2024.s3.us-east-2.amazonaws.com/Symbol_animation___1__1788518733226_dp95.gif"
                alt=""
                aria-hidden="true"
                referrerPolicy="no-referrer"
                className="h-12 w-12 shrink-0 object-cover object-center"
              />
              <p>{status || "Nexuses is working…"}</p>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-500">{error}</p> : null}
          </div>
        </div>

        {integrations.length ? (
          <div className="flex shrink-0 flex-wrap gap-2 pb-3">
            {integrations.map((item) => (
              <span
                key={item._id}
                className="rounded-full bg-ink-2 px-3 py-1 text-xs text-sea"
              >
                {item.name}
              </span>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={send}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="shrink-0 bg-ink pb-6 pt-2"
        >
          <div
            className={`rounded-3xl border bg-panel p-3 ${
              dragging ? "border-sea" : "border-line"
            }`}
          >
            {files.length ? (
              <div className="mb-2 flex flex-wrap gap-2 px-2 pt-1">
                {files.map((item, index) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-full border border-line bg-ink-2 py-1 pl-1 pr-3 text-xs"
                  >
                    {item.preview ? (
                      <img
                        src={item.preview}
                        alt=""
                        className="h-7 w-7 rounded-full object-cover"
                      />
                    ) : null}
                    <span className="max-w-[160px] truncate text-paper">{item.file.name}</span>
                    <span className="text-muted">{formatSize(item.file.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="text-muted hover:text-paper"
                      aria-label={`Remove ${item.file.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder={
                dragging
                  ? "Drop files here"
                  : "Ask anything, or attach a file. Shift+Enter for a new line."
              }
              className="w-full resize-none bg-transparent px-2 py-2 text-paper outline-none placeholder:text-muted"
            />
            <div className="flex items-center justify-between px-2 pb-1">
              <div className="flex items-center gap-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept={ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 text-xs text-muted hover:text-sea"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    aria-hidden
                  >
                    <path
                      d="M21.44 11.05 12.7 19.78a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.83l8.48-8.48"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Attach
                </button>
                <button
                  type="button"
                  onClick={() => setPanelOpen(true)}
                  className="text-xs text-muted hover:text-sea"
                >
                  Add Attio, Brevo, Lemlist, or Other
                </button>
              </div>
              <button
                type="submit"
                disabled={busy || (!input.trim() && !files.length)}
                className="rounded-full bg-sea px-5 py-2 text-sm font-semibold text-on-sea disabled:opacity-40"
              >
                Send
              </button>
            </div>
          </div>
        </form>
      </main>

      {panelOpen ? (
        <IntegrationsPanel
          projectId={project._id}
          integrations={integrations}
          onChange={setIntegrations}
          onClose={() => setPanelOpen(false)}
        />
      ) : null}
      {automationsOpen ? (
        <AutomationsPanel
          automations={automations}
          stoppingId={stoppingId}
          onStop={(item) => void stopRunningAutomation(item)}
          onRefresh={() => void refreshAutomations()}
          onClose={() => setAutomationsOpen(false)}
        />
      ) : null}
      </div>
    </div>
  );
}
