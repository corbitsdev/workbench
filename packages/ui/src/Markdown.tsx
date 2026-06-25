import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { cn } from "./utils";

// Token-only component overrides so rendered markdown inherits the workbench
// palette (text / text-2 / text-3) rather than react-markdown's bare defaults.
// Kept module-level so the object identity is stable across renders.
const components: Components = {
  h1: ({ children }) => (
    <h2 className="mb-2 mt-4 text-[15px] font-semibold text-text">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h3 className="mb-2 mt-4 text-[14px] font-semibold text-text">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-1.5 mt-3 text-[13px] font-semibold text-text">
      {children}
    </h4>
  ),
  h4: ({ children }) => (
    <h5 className="mb-1.5 mt-3 text-[13px] font-semibold text-text-2">
      {children}
    </h5>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-[13px] leading-relaxed text-text-2">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px] text-text-2">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-[13px] text-text-2">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-text">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-orange hover:underline"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-[13px] italic text-text-3">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-text-2">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-[8px] border border-border bg-surface-2 p-3 text-[12px] text-text-2">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}): ReactNode {
  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
