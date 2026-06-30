import type { ReactNode } from "react";
import { Streamdown, type Components } from "streamdown";
import { cn } from "./utils";

// The single markdown rendering path for the whole app — chat bubbles, research
// briefs, artifact bodies, and the A/B comparison view all route through here.
// Streamdown is the engine (GFM tables/task-lists/strikethrough/autolinks for
// free, plus graceful handling of half-written markdown while a turn streams).
// Every element is mapped to a workbench-token class so the output is one
// coherent typographic system rather than the renderer's bare defaults — no
// hardcoded colors or radii (see packages/ui/src/styles.css for the tokens).

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-8 text-balance text-2xl font-semibold leading-tight text-text">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-3 mt-7 text-balance text-xl font-semibold leading-snug text-text">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-6 text-balance text-base font-semibold leading-snug text-text">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-2 mt-5 text-balance text-[15px] font-semibold leading-snug text-text">
      {children}
    </h4>
  ),
  p: ({ children }) => <p className="my-4 text-pretty leading-7">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-4 list-disc space-y-1.5 pl-5 marker:text-text-3 [&_ol]:my-1.5 [&_ul]:my-1.5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-1.5 pl-5 marker:font-medium marker:text-text-3 [&_ol]:my-1.5 [&_ul]:my-1.5">
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="text-pretty pl-1 leading-7">{children}</li>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => (
    <del className="text-text-3 line-through">{children}</del>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-[text-decoration-color] hover-hover:decoration-accent"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 rounded-sm border-l-2 border-accent/40 bg-surface-2/50 py-2 pl-4 pr-3 italic text-text-2 [&>p]:my-1">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,
  // Inline code always gets the bordered chip. A fenced block is the same <code>
  // nested in <pre>; the `.wb-markdown pre code` reset in styles.css sheds the
  // chip there so the block sits flat on the <pre> surface. This avoids sniffing
  // the content to guess inline-vs-block (newlines in an inline span would fool
  // that), and keeps the hast `node` prop off the DOM.
  code: ({ children }) => (
    <code className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-text">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded border border-border bg-surface-2 p-4 font-mono text-[13px] leading-relaxed text-text-2">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded border border-border">
      <table className="w-full border-collapse text-left text-sm tabular-nums [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:nth-child(even)]:bg-surface-2/40">
        {children}
      </table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border-b border-border bg-surface-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-text-3"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      style={style}
      className="border-b border-border px-4 py-2.5 align-top text-text-2"
    >
      {children}
    </td>
  ),
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="my-4 max-w-full rounded outline outline-1 -outline-offset-1 outline-border"
    />
  ),
};

export interface MarkdownProps {
  children: string;
  className?: string;
  /**
   * `streaming` lets the engine tolerate half-written markdown mid-turn (an
   * unclosed `**`, a partial table); `static` (default) is for settled content.
   */
  mode?: "static" | "streaming";
}

export function Markdown({
  children,
  className,
  mode = "static",
}: MarkdownProps): ReactNode {
  return (
    <div
      className={cn(
        // The `wb-markdown` hook lets styles.css reach the footnote citation
        // markers and section, which the component map can't key on. Streamdown
        // trims its own first/last block margins, so no edge-trim is needed here.
        "wb-markdown break-words text-[15px] leading-7 text-text-2",
        className,
      )}
    >
      <Streamdown mode={mode} controls={false} components={components}>
        {children}
      </Streamdown>
    </div>
  );
}
