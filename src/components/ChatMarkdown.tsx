"use client";

import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sea underline decoration-sea/40 underline-offset-2 hover:text-sea-2"
    >
      {children}
    </a>
  ),
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
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-2xl bg-ink-2 px-4 py-3 text-sm leading-6 text-paper">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const block = Boolean(className) || String(children).includes("\n");
    if (block) {
      return <code className="font-mono text-[13px]">{children}</code>;
    }
    return (
      <code className="rounded-md bg-ink-2 px-1.5 py-0.5 font-mono text-[13px] text-paper">
        {children}
      </code>
    );
  },
};

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {repairMarkdownTables(unwrap(content))}
      </ReactMarkdown>
    </div>
  );
}
