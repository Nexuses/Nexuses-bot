import { jsonError } from "@/lib/api";
import {
  buildFilePrompt,
  extractUploadedFile,
  MAX_CHAT_FILES,
  type ExtractedFile,
} from "@/lib/attachments";
import { ensureAutomationRunner } from "@/lib/automations";
import { openingStatus, statusForTool } from "@/lib/chat-status";
import { HTML_DASHBOARD_PROMPT } from "@/lib/html-dashboard-kit";
import {
  ensureLiveShareInReply,
  parseShareUrlFromToolResult,
} from "@/lib/html-shares";
import { getOwnedChat, serializeChat, titleFromText } from "@/lib/chats";
import { redactSecrets } from "@/lib/integrations";
import { knownCustomApiGuide } from "@/lib/known-custom-apis";
import { complete, type ContentPart, type LlmMessage } from "@/lib/llm";
import { requireProjectMember } from "@/lib/project-access";
import { serializeIntegration } from "@/lib/serialize-integration";
import { serializeMessage } from "@/lib/serialize-message";
import { runTool, toolDefinitions, type StoredIntegration } from "@/lib/tools";
import { Chat } from "@/models/Chat";
import { Integration } from "@/models/Integration";
import { Message } from "@/models/Message";

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

function looksLikeWork(text: string) {
  return /\b(create|add|make|update|delete|remove|send|find|search|list|get|put|connect|set up|setup|build|insert|change|assign|move|keep|continue|auto[- ]?update|sync)\b/i.test(
    text,
  );
}

async function withSlowHint<T>(
  send: (payload: Record<string, unknown>) => void,
  hint: string,
  task: Promise<T>,
) {
  const timer = setTimeout(() => send({ type: "status", text: hint }), 4000);
  try {
    return await task;
  } finally {
    clearTimeout(timer);
  }
}

function providerGuide(integrations: StoredIntegration[]) {
  const parts: string[] = [];
  if (integrations.some((item) => item.provider === "attio")) {
    parts.push(`Attio is connected. Execute Attio work with tools.
- Create a list/pipeline with stages: call attio_create_list with name and stages. Do this for requests like "create a list named X with stages A, B, C".
- Import a CSV into a list/stage: call attio_import_to_list ONCE with the list name and stage. Do not loop attio_api for each row.
- Inspect lists: attio_list_lists.
- Search people/companies: attio_query_records.
- Anything else: attio_api with method + path starting /v2/. Write bodies use {"data":{...}}.
  POST /v2/lists, POST /v2/lists/{id}/attributes, POST /v2/lists/{id}/attributes/{attr}/statuses, POST /v2/objects/{object}/records.`);
  }
  if (integrations.some((item) => item.provider === "brevo")) {
    const brevo = integrations.find((item) => item.provider === "brevo");
    if (brevo?.mcpUrl) {
      parts.push(`Brevo is connected via MCP${integrations.find((i) => i.provider === "brevo")?.restApiKey ? " + REST API key" : ""}.
- For campaigns / partial lists: call brevo_list_campaigns (omit status unless user asked for sent/draft).
- For who opened / clicked a campaign: call brevo_people_by_event once with campaign + event (opens/clicks). Do not say this is impossible.
- If brevo_people_by_event returns needsRestApiKey, ask the user to paste a standard Brevo API key (Settings → SMTP & API → API key WITHOUT the MCP option) and call connect_integration — it adds REST alongside MCP on the same Brevo connection. Do not ask for two separate Brevo apps.
- To explore other MCP actions: brevo_mcp_list_tools with a query. Then brevo_mcp_call with an exact name.
- Keep Attio updated automatically until a campaign completes: start_campaign_automation with source brevo.`);
    } else {
      parts.push(
        `Brevo is connected via REST API. List campaigns with brevo_list_campaigns. Who opened/clicked: brevo_people_by_event. Create contacts with brevo_create_contact. For other actions use brevo_api with /v3/ paths. For fuller MCP tools, also connect an MCP key ( Brevo keeps both on one integration).`,
      );
    }
  }
  if (integrations.some((item) => item.provider === "lemlist")) {
    parts.push(`Lemlist is connected.
- List campaigns / completed campaigns: call lemlist_list_campaigns once. Completed means status ended.
- Who opened, clicked, or replied in a campaign: call lemlist_people_by_event ONCE with the campaign name and event (opens, clicks, replies). Then answer with a table of emails. Do not paginate. Do not call lemlist_api for this.
- Keep Attio updated automatically until a campaign completes: call start_campaign_automation with source lemlist, campaign, and attio_list.
- Other Lemlist work: lemlist_api with /api/ paths.`);
  }
  if (integrations.some((item) => item.provider === "notion")) {
    parts.push(`Notion is connected (OAuth).
- Search pages/databases: notion_search.
- Create a page under a parent: notion_create_page with parent_page_id + title.
- Other Notion REST: notion_api with /v1/ paths.
- Only pages/databases the user shared with the integration are visible.`);
  } else {
    parts.push(`Notion is not connected yet.
- If the user asks to integrate / connect Notion: call start_oauth_connect with provider notion and put the button_markdown link in your reply (Connect Notion button → Notion authorize page).`);
  }
  if (integrations.some((item) => item.provider === "other")) {
    const custom = integrations.filter((item) => item.provider === "other");
    const known = knownCustomApiGuide(custom);
    parts.push(`Custom APIs are connected. Use custom_api_request to finish the user's task against those APIs.
- SmartLead (name/base contains smartlead): the server adds ?api_key= automatically. Call paths like /campaigns or /campaigns/{id}/analytics. Base URL should be https://server.smartlead.ai/api/v1. Never put the API key in the path yourself.
- MailBluster: base https://api.mailbluster.com; Authorization header is the raw API key (no Bearer). Developer API is Leads/Fields/Products/Orders only — NO campaign send/open/click/bounce reports. Do not invent campaign endpoints; tell the user to use Brevo, Lemlist, or SmartLead for campaign analytics.${known ? `\n${known}` : ""}`);
  }
  return parts.join("\n");
}

async function readChatInput(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const text = String(form.get("message") ?? "").trim();
    const files = form
      .getAll("files")
      .filter((item): item is File => {
        if (typeof item !== "object" || item === null) return false;
        const file = item as File;
        return typeof file.arrayBuffer === "function" && typeof file.name === "string" && file.size > 0;
      });
    return { text, files, chatId: String(form.get("chatId") ?? "").trim() };
  }
  const body = await request.json().catch(() => null);
  return {
    text: String(body?.message ?? "").trim(),
    files: [] as File[],
    chatId: String(body?.chatId ?? "").trim(),
  };
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const { session, project, error } = await requireProjectMember(id);
  if (error || !session || !project) return error ?? jsonError("Unauthorized", 401);

  ensureAutomationRunner();

  const { text, files, chatId: requestedChatId } = await readChatInput(request);
  if (files.length > MAX_CHAT_FILES) return jsonError(`You can attach up to ${MAX_CHAT_FILES} files`);
  if (!text && !files.length) return jsonError("Message or file is required");
  if (text.length > 8000) return jsonError("Message is too long");

  let extracted: ExtractedFile[] = [];
  try {
    extracted = await Promise.all(files.map((file) => extractUploadedFile(file)));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Could not read a file");
  }

  const displayText =
    text ||
    (extracted.length === 1
      ? `Uploaded ${extracted[0].meta.name}`
      : `Uploaded ${extracted.length} files`);
  const llmText = buildFilePrompt(displayText, extracted);
  const attachments = extracted.map((item) => item.meta);
  const imageParts: ContentPart[] = extracted.flatMap((item) =>
    item.image
      ? [
          {
            type: "image_url" as const,
            image_url: {
              url: `data:${item.image.mime};base64,${item.image.base64}`,
              detail: "high" as const,
            },
          },
        ]
      : [],
  );
  const userContent: string | ContentPart[] = imageParts.length
    ? [{ type: "text", text: llmText }, ...imageParts]
    : llmText;

  let chat = requestedChatId
    ? await getOwnedChat(session.userId, id, requestedChatId)
    : null;
  if (requestedChatId && !chat) return jsonError("Chat not found", 404);
  if (!chat) {
    chat = await Chat.create({
      userId: session.userId,
      projectId: id,
      title: titleFromText(displayText),
    });
  } else if (!chat.title || chat.title === "New chat") {
    chat.title = titleFromText(displayText);
    await chat.save();
  } else {
    chat.updatedAt = new Date();
    await chat.save();
  }

  const [history, integrationDocs] = await Promise.all([
    Message.find({ userId: session.userId, projectId: id, chatId: chat._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    Integration.find({ userId: session.userId, projectId: id }).lean(),
  ]);

  const integrations: StoredIntegration[] = integrationDocs.map((doc) => ({
    _id: String(doc._id),
    provider: doc.provider,
    name: doc.name,
    apiKey: doc.apiKey,
    restApiKey: doc.restApiKey || "",
    baseUrl: doc.baseUrl,
    mcpUrl: doc.mcpUrl,
    authType: doc.authType,
  }));

  const connected = integrations.map((item) =>
    item.provider === "other" ? `${item.name} (custom)` : item.name,
  );

  const system = `You are Nexuses, a Grok-style action agent for the project "${project.name}".
You do the work. You are not a documentation bot.

Rules:
- When the user asks to create, update, delete, send, search, or fetch something, you MUST call tools and complete it in their connected APIs.
- Never answer with only steps, sample JSON, or "you can do this in Attio/Brevo/Lemlist". Execute it.
- If a tool errors, fix the payload and retry. Only stop after a real API success or a hard permission error.
- After tools succeed, tell the user what changed in plain language: names, counts, status, dates. Do not mention IDs.
- Users can connect tools in chat.
  - Attio / Brevo / Lemlist (API key): if they paste a key, call connect_integration immediately. Do not only send them to the Integrations panel.
  - Notion (OAuth): if they say integrate / connect Notion and did NOT paste a key, call start_oauth_connect with provider notion, then put the exact button_markdown from the tool result in your reply so they get a Connect Notion button that opens Notion's authorize page. After they return, tools work.
- After a successful connect, continue with their original request using the new tools in the same turn when possible.
- Never repeat a full API key in your reply. Confirm with the last 4 characters only (key hint).
- If they ask what is connected, call list_integrations. If they ask to remove one, call disconnect_integration.
- If the user asks to keep updating / continue updating / auto-update Attio from a running Lemlist or Brevo campaign until it completes: call start_campaign_automation (source, campaign, attio_list). Tell them automatic updates are running and will keep syncing in the background until the campaign ends (or they ask to stop). Use list_automations / stop_automation when they ask about or stop that job.
- If the needed API is not connected and they did not provide a key:
  - For Notion: call start_oauth_connect (Connect button).
  - For others: ask them to paste the API key here in chat (or use Integrations).
- Never reveal API keys.
- If the user pastes a documentation or web URL (or asks you to read / open / summarize a link), call fetch_url. Never say you cannot browse the web or that you lack web access.

What the user sees (required):
- Never show IDs, UUIDs, api slugs, record ids, list ids, campaign ids, attribute ids, or similar internal keys unless the user explicitly asks for an ID.
- Tables and lists should use useful fields only: name, email, status, stage, date, owner, count, error message.
- Keep IDs for your own tool calls. Do not put them in the final answer.

Formatting (required):
- Write the final answer in clean Markdown. Use headings, short paragraphs, and bullet lists.
- When showing 2 or more items with the same fields, use a Markdown table with a header row.
- When showing HTML (page, email, invite, dashboard), put it in an html fenced code block (triple backticks + html) so the user gets Preview and Share link buttons.
- For a live / public / shareable dashboard link: you MUST call share_html with the full HTML and paste ONLY the exact url from that tool result. NEVER invent or guess a /p/... URL — fake links 404.
${HTML_DASHBOARD_PROMPT}
- If files are attached, treat their extracted contents as source data and use them to finish the task (import contacts, create records, summarize, and so on).
- If images or screenshots are attached, you CAN see them. Read the pixels, extract visible text, and answer from what is in the image. Never say you cannot view images.
- If the user uploads a CSV for Attio, call attio_import_to_list once. Never import contacts one API call at a time.
- If the user asks who opened / clicked / replied in a Lemlist campaign, call lemlist_people_by_event once. Never page through activities with repeated lemlist_api calls.
- If the user asks for Brevo campaigns / a partial campaign list, call brevo_list_campaigns once without status. Use status sent only when they ask for completed/sent campaigns.
- If the user asks who opened/clicked a Brevo campaign, call brevo_people_by_event once. Do not claim it is impossible. If the tool says needsRestApiKey, ask them to paste a standard (non-MCP) Brevo API key and connect it — it is stored alongside MCP.
- Stay on the product the user is talking about. A Lemlist question is not an Attio import.

Connected APIs: ${connected.length ? connected.join(", ") : "none yet"}.
Project: ${project.name}. Project logo URL (use as client logo on the right of HTML report headers unless the user gives another): ${project.logo || "none — ask the user for the client logo URL if making a branded dashboard"}.
Nexuses logo URL (always available — use this image for Nexuses branding in HTML/emails/reports; do not invent another): https://cdn-nexlink.s3.us-east-2.amazonaws.com/Nexuses-full-logo-dark_8d412ea3-bf11-4fc6-af9c-bee7e51ef494.png.
${providerGuide(integrations)}`;

  const llmMessages: LlmMessage[] = [
    { role: "system", content: system },
    ...history.reverse().map((message): LlmMessage => {
      if (message.role === "assistant") {
        return { role: "assistant", content: String(message.content || "") };
      }
      return { role: "user", content: String(message.content || "") };
    }),
    { role: "user", content: userContent },
  ];

  const userMessage = await Message.create({
    userId: session.userId,
    projectId: id,
    chatId: chat._id,
    role: "user",
    content: displayText,
    attachments,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const toolsUsed: string[] = [];
      const secretsUsed: string[] = [];
      const shareUrls: string[] = [];
      let nudged = false;
      let activeTools = toolDefinitions(integrations);

      const publishIntegrations = () => {
        send({
          type: "integrations",
          integrations: integrations.map((item) =>
            serializeIntegration({
              _id: item._id,
              provider: item.provider,
              name: item.name,
              apiKey: item.apiKey,
              baseUrl: item.baseUrl,
              mcpUrl: item.mcpUrl,
              authType: item.authType,
            }),
          ),
        });
      };

      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
        send({
          type: "status",
          text: openingStatus(text || displayText, files.map((file) => file.name)),
        });

        for (let round = 0; round < 12; round += 1) {
          if (round === 2) send({ type: "status", text: "Still working — this can take a little time…" });
          if (round === 5) send({ type: "status", text: "Almost there. Finishing up…" });

          activeTools = toolDefinitions(integrations);
          const reply = await withSlowHint(
            send,
            "This is taking a little time…",
            complete(llmMessages, activeTools),
          );
          if (reply.tool_calls?.length) {
            llmMessages.push({
              role: "assistant",
              content: reply.content ?? "",
              tool_calls: reply.tool_calls,
            });
            for (const call of reply.tool_calls) {
              toolsUsed.push(call.function.name);
              send({ type: "status", text: statusForTool(call.function.name) });
              let result = "";
              try {
                result = await runTool(call.function.name, call.function.arguments, integrations, {
                  files: extracted.map((item) => ({ name: item.meta.name, text: item.text })),
                  onStatus: (statusText) => send({ type: "status", text: statusText }),
                  userId: session.userId,
                  projectId: id,
                  projectName: project.name,
                  projectLogo: project.logo,
                  origin: new URL(request.url).origin,
                  secretsUsed,
                  onIntegrationsChange: () => publishIntegrations(),
                });
              } catch (err) {
                result = `Tool error: ${err instanceof Error ? err.message : "failed"}`;
              }
              if (call.function.name === "share_html") {
                const url = parseShareUrlFromToolResult(result);
                if (url) shareUrls.push(url);
              }
              llmMessages.push({
                role: "tool",
                tool_call_id: call.id,
                content: result,
              });
            }
            send({ type: "status", text: "Checking the result…" });
            continue;
          }

          if (
            activeTools.length &&
            looksLikeWork(`${text} ${displayText}`) &&
            !nudged &&
            toolsUsed.length === 0
          ) {
            nudged = true;
            send({ type: "status", text: "Doing the work in your connected apps…" });
            llmMessages.push({
              role: "user",
              content:
                "That reply did not call any tools. Execute the request now with the connected APIs. If an API key was provided, connect it first with connect_integration, then finish the task. Do not explain how.",
            });
            continue;
          }

          if (secretsUsed.length) {
            userMessage.content = redactSecrets(String(userMessage.content || ""), secretsUsed);
            await userMessage.save();
          }

          send({ type: "status", text: "Writing the reply…" });
          const content = await ensureLiveShareInReply({
            content: redactSecrets(
              (reply.content || "I could not generate a reply.").trim(),
              secretsUsed,
            ),
            userText: `${text} ${displayText}`,
            realShareUrls: shareUrls,
            userId: session.userId,
            projectId: id,
            projectLogo: project.logo,
            projectName: project.name,
            origin: new URL(request.url).origin,
          });
          const saved = await Message.create({
            userId: session.userId,
            projectId: id,
            chatId: chat._id,
            role: "assistant",
            content,
            toolsUsed,
          });
          send({
            type: "done",
            message: serializeMessage(saved),
            chat: serializeChat(chat),
            userMessage: serializeMessage(userMessage),
            integrations: integrations.map((item) =>
              serializeIntegration({
                _id: item._id,
                provider: item.provider,
                name: item.name,
                apiKey: item.apiKey,
                baseUrl: item.baseUrl,
                mcpUrl: item.mcpUrl,
                authType: item.authType,
              }),
            ),
          });
          return;
        }

        if (secretsUsed.length) {
          userMessage.content = redactSecrets(String(userMessage.content || ""), secretsUsed);
          await userMessage.save();
        }

        send({ type: "status", text: "Putting together what I found…" });
        llmMessages.push({
          role: "user",
          content:
            "Stop calling tools. Answer the user's last question now using only the tool results you already have. If the list is incomplete, show what you have. Stay on that product (Lemlist, Attio, or Brevo). Do not mention Attio unless this was an Attio request. Do not mention IDs. Never repeat API keys.",
        });
        const last = await complete(llmMessages, []);
        const content = await ensureLiveShareInReply({
          content: redactSecrets(
            (
              last.content ||
              (toolsUsed.some((name) => name.startsWith("lemlist"))
                ? "I started pulling that Lemlist list but ran out of steps. Ask me again for the emails who opened, clicked, or replied in that campaign — I will fetch it in one go."
                : toolsUsed.some((name) => name.startsWith("attio"))
                  ? "I started the Attio work but ran out of steps. Ask me again and I will finish it in one bulk action."
                  : "I started the work but ran out of steps. Ask me once more and I will finish it.")
            ).trim(),
            secretsUsed,
          ),
          userText: `${text} ${displayText}`,
          realShareUrls: shareUrls,
          userId: session.userId,
          projectId: id,
          projectLogo: project.logo,
          projectName: project.name,
          origin: new URL(request.url).origin,
        });
        const saved = await Message.create({
          userId: session.userId,
          projectId: id,
          chatId: chat._id,
          role: "assistant",
          content,
          toolsUsed,
        });
        send({
          type: "done",
          message: serializeMessage(saved),
          chat: serializeChat(chat),
          userMessage: serializeMessage(userMessage),
          integrations: integrations.map((item) =>
            serializeIntegration({
              _id: item._id,
              provider: item.provider,
              name: item.name,
              apiKey: item.apiKey,
              baseUrl: item.baseUrl,
              mcpUrl: item.mcpUrl,
              authType: item.authType,
            }),
          ),
        });
      } catch (err) {
        send({
          type: "error",
          error: err instanceof Error ? err.message : "Chat failed",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
