"use client";

import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { enhanceSharedHtml } from "@/lib/html-dashboard-kit";

type Branding = {
  projectId?: string;
  clientLogoUrl?: string;
  clientName?: string;
};

const BrandingContext = createContext<Branding>({});

function useBranding() {
  return useContext(BrandingContext);
}

function unwrap(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : content;
}

function isTableSep(value?: string) {
  return Boolean(value && /^\s*\|?\s*:?-{2,}(\s*\|+\s*:?-{2,})+\s*\|?\s*$/.test(value));
}

function isTableRow(value?: string) {
  return Boolean(
    value && /\|/.test(value) && !isTableSep(value) && /^\s*\|?.+\|.+/.test(value),
  );
}

function separatorFor(line: string) {
  const parts = line.trim().split("|");
  const cols = parts.filter((part, index) => {
    if (index === 0 && part.trim() === "") return false;
    if (index === parts.length - 1 && part.trim() === "") return false;
    return true;
  });
  return line.trim().startsWith("|")
    ? `| ${cols.map(() => "---").join(" | ")} |`
    : cols.map(() => "---").join(" | ");
}

function repairMarkdownTables(text: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inTable = false;
  let sawSeparator = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      inTable = false;
      sawSeparator = false;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1];
    if (isTableRow(line) || isTableSep(line)) {
      if (!inTable && isTableRow(line) && isTableRow(next) && !isTableSep(next)) {
        out.push(line);
        out.push(separatorFor(line));
        inTable = true;
        sawSeparator = true;
        continue;
      }
      if (inTable && isTableSep(line) && sawSeparator) {
        continue;
      }
      inTable = true;
      if (isTableSep(line)) sawSeparator = true;
      out.push(line);
      continue;
    }

    inTable = false;
    sawSeparator = false;
    out.push(line);
  }

  return out.join("\n");
}

function cellText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(cellText).join("");
  if (typeof node === "object" && node && "props" in node) {
    return cellText((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && node && "props" in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

function isHtmlLanguage(className?: string) {
  return /\blanguage-(html|htm|xhtml|svg)\b/i.test(className || "");
}

function looksLikeHtml(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return true;
  if (/^<(svg|body|head|main|section|div|table|form|style)[\s>]/i.test(trimmed) && /<\/[a-z]+>\s*$/i.test(trimmed)) {
    return trimmed.includes("<") && trimmed.includes(">");
  }
  return false;
}

function extractStandaloneHtml(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:html|htm|xhtml|svg)\s*\n([\s\S]*?)\n```$/i);
  if (fenced) return fenced[1].trim();
  if (looksLikeHtml(trimmed) && !trimmed.includes("```")) return trimmed;
  return "";
}

function HtmlPreviewModal({
  html,
  open,
  onClose,
}: {
  html: string;
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 sm:p-8">
      <button className="absolute inset-0" aria-label="Close preview" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(88vh,880px)] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-line bg-panel shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <p id={titleId} className="font-display text-lg tracking-tight">
            HTML preview
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line px-3 py-1.5 text-sm text-muted hover:border-sea hover:text-paper"
          >
            Close
          </button>
        </div>
        <iframe
          title="HTML preview"
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={html}
          className="h-full w-full flex-1 bg-white"
        />
      </div>
    </div>
  );
}

function PreviewButton({
  html,
  clientLogoUrl,
  clientName,
}: {
  html: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  const [open, setOpen] = useState(false);
  const previewHtml = enhanceSharedHtml(html, {
    clientLogoUrl,
    clientName,
  });
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium text-sea hover:border-sea hover:bg-ink-2"
      >
        Preview
      </button>
      <HtmlPreviewModal html={previewHtml} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function ShareLinkButton({
  html,
  projectId,
  clientLogoUrl,
  clientName,
}: {
  html: string;
  projectId?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function createLink() {
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // Keep the link visible even if clipboard is blocked.
      }
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          html,
          projectId: projectId || undefined,
          clientLogoUrl: clientLogoUrl || undefined,
          clientName: clientName || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { share?: { url?: string }; error?: string }
        | null;
      if (!res.ok || !data?.share?.url) {
        setError(data?.error || "Could not create link");
        return;
      }
      setUrl(data.share.url);
      try {
        await navigator.clipboard.writeText(data.share.url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        // Link still shown below.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void createLink()}
        disabled={busy}
        className="rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium text-sea hover:border-sea hover:bg-ink-2 disabled:opacity-60"
      >
        {busy ? "Sharing…" : copied ? "Copied" : url ? "Copy link" : "Share link"}
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="max-w-[220px] truncate text-[11px] text-muted underline decoration-line underline-offset-2 hover:text-sea"
        >
          {url}
        </a>
      ) : null}
      {error ? <p className="max-w-[220px] text-right text-[11px] text-red-500">{error}</p> : null}
    </div>
  );
}

function HtmlActions({ html }: { html: string }) {
  const branding = useBranding();
  return (
    <div className="flex items-start gap-2">
      <PreviewButton
        html={html}
        clientLogoUrl={branding.clientLogoUrl}
        clientName={branding.clientName}
      />
      <ShareLinkButton
        html={html}
        projectId={branding.projectId}
        clientLogoUrl={branding.clientLogoUrl}
        clientName={branding.clientName}
      />
    </div>
  );
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const text = nodeText(children).replace(/\n$/, "");
  const htmlBlock = isHtmlLanguage(className) || looksLikeHtml(text);

  if (!htmlBlock) {
    return (
      <pre className="my-3 overflow-x-auto rounded-2xl bg-ink-2 px-4 py-3 text-sm leading-6 text-paper">
        <code className={`font-mono text-[13px] ${className || ""}`}>{children}</code>
      </pre>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-2xl border border-line bg-ink-2">
      <div className="flex items-center justify-between gap-3 border-b border-line/80 px-4 py-2">
        <span className="text-xs uppercase tracking-[0.14em] text-muted">HTML</span>
        <HtmlActions html={text} />
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-sm leading-6 text-paper">
        <code className={`font-mono text-[13px] ${className || ""}`}>{children}</code>
      </pre>
    </div>
  );
}

function ShareReportCard({ href, label }: { href: string; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [html, setHtml] = useState("");
  const [error, setError] = useState("");
  const idMatch = href.match(/\/p\/([A-Za-z0-9_-]+)/);
  const publicId = idMatch?.[1] || "";

  async function openPreview() {
    if (!publicId) return;
    if (html) {
      setOpen(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/shares/public/${encodeURIComponent(publicId)}`);
      const data = (await res.json().catch(() => null)) as
        | { html?: string; error?: string }
        | null;
      if (!res.ok || !data?.html) {
        setError(data?.error || "Could not load report HTML");
        return;
      }
      setHtml(data.html);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load report HTML");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="my-3 flex flex-col gap-2 rounded-2xl border border-line bg-ink-2/80 p-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0">
        <span className="block text-xs uppercase tracking-[0.14em] text-muted">Report</span>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 block truncate text-sm text-sea underline decoration-sea/40 underline-offset-2 hover:text-sea-2"
        >
          {label || href}
        </a>
        {error ? <span className="mt-1 block text-xs text-red-500">{error}</span> : null}
      </span>
      <span className="flex shrink-0 flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void openPreview()}
          disabled={busy || !publicId}
          className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-sea hover:border-sea hover:bg-ink-2 disabled:opacity-60"
        >
          {busy ? "Loading…" : "Preview HTML"}
        </button>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-paper no-underline hover:border-sea"
        >
          Open link
        </a>
      </span>
      <HtmlPreviewModal html={html} open={open} onClose={() => setOpen(false)} />
    </span>
  );
}

function isPublicShareUrl(url: string) {
  return /\/p\/[A-Za-z0-9_-]+(?:[?#].*)?$/i.test(url.trim());
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 font-display text-2xl tracking-tight text-paper">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 font-display text-xl tracking-tight text-paper">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-4 font-display text-lg tracking-tight text-paper">{children}</h3>
  ),
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-7 text-paper">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1.5 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-7 text-paper [&>p]:mb-0">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-paper">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => {
    const url = href || "";
    const isOauthConnect = /\/api\/oauth\/[^/]+\/start\b/i.test(url);
    if (isOauthConnect) {
      return (
        <a
          href={url}
          className="my-2 inline-flex items-center justify-center rounded-full bg-sea px-5 py-2.5 text-sm font-semibold text-ink no-underline shadow-sm transition hover:bg-sea-2"
        >
          {children}
        </a>
      );
    }
    if (isPublicShareUrl(url)) {
      return <ShareReportCard href={url} label={children} />;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-sea underline decoration-sea/40 underline-offset-2 hover:text-sea-2"
      >
        {children}
      </a>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-sea/50 pl-4 text-muted">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[280px] border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-ink-2 text-paper">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-line">{children}</tbody>,
  tr: ({ children }) => {
    const text = cellText(children).replace(/\s/g, "");
    if (/^-+$/.test(text)) return null;
    return <tr className="align-top">{children}</tr>;
  },
  th: ({ children }) => (
    <th className="whitespace-nowrap px-3 py-2 font-semibold text-paper">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-2 text-paper">{children}</td>,
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (
      typeof child === "object" &&
      child &&
      "props" in child &&
      (child as { props?: { className?: string; children?: ReactNode } }).props
    ) {
      const props = (child as { props: { className?: string; children?: ReactNode } }).props;
      return <CodeBlock className={props.className}>{props.children}</CodeBlock>;
    }
    return (
      <pre className="my-3 overflow-x-auto rounded-2xl bg-ink-2 px-4 py-3 text-sm leading-6 text-paper">
        {children}
      </pre>
    );
  },
  code: ({ className, children }) => {
    const block = Boolean(className) || String(children).includes("\n");
    if (block) {
      return <code className={`font-mono text-[13px] ${className || ""}`}>{children}</code>;
    }
    return (
      <code className="rounded-md bg-ink-2 px-1.5 py-0.5 font-mono text-[13px] text-paper">
        {children}
      </code>
    );
  },
};

export function ChatMarkdown({
  content,
  projectId,
  clientLogoUrl,
  clientName,
}: {
  content: string;
  projectId?: string;
  clientLogoUrl?: string;
  clientName?: string;
}) {
  const prepared = repairMarkdownTables(unwrap(content));
  const standalone = extractStandaloneHtml(prepared);
  const branding = { projectId, clientLogoUrl, clientName };

  if (standalone) {
    return (
      <BrandingContext.Provider value={branding}>
        <div className="chat-md space-y-3">
          <div className="overflow-hidden rounded-2xl border border-line bg-ink-2">
            <div className="flex items-center justify-between gap-3 border-b border-line/80 px-4 py-2">
              <span className="text-xs uppercase tracking-[0.14em] text-muted">HTML</span>
              <HtmlActions html={standalone} />
            </div>
            <pre className="overflow-x-auto px-4 py-3 text-sm leading-6 text-paper">
              <code className="font-mono text-[13px]">{standalone}</code>
            </pre>
          </div>
        </div>
      </BrandingContext.Provider>
    );
  }

  return (
    <BrandingContext.Provider value={branding}>
      <div className="chat-md">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {prepared}
        </ReactMarkdown>
      </div>
    </BrandingContext.Provider>
  );
}
