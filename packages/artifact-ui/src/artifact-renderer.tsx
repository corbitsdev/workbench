// Typed, read-only renderers for artifact content — one per
// `ArtifactRendererKind` (see `renderer-kind.ts`), dispatched by
// `ArtifactRenderer`. Every host (canvas pane, Library detail preview, an
// opened chat blob) renders through this one component so a kind's shape
// only has one implementation.
//
// Read-only phase (CL-5938): no editing affordances here at all — the
// multiplayer-editing half is CL-5958's substrate to build on top of this.

import { CsvTable } from "@corbits/react-ui";
import { FileQuestion } from "lucide-react";
import type { ArtifactRendererKind } from "./renderer-kind";

export type ArtifactRenderProps = {
  readonly rendererKind: ArtifactRendererKind;
  readonly title: string;
  /** Empty string is a legitimate, honestly-rendered "nothing here" —
   * never distinguished from "not fetched yet" (the host's own loading
   * state handles that before this component ever mounts). */
  readonly content: string;
  /** Overrides the default "unsupported" copy with something specific to
   * why this content can't be shown (e.g. a binary MIME type). */
  readonly unavailableReason?: string;
  /**
   * The sandboxed preview route (`GET .../artifacts/:id/preview`) for a
   * `"html"`-kind artifact — the `<iframe sandbox="allow-scripts">`'s
   * `src`. Absent when the host has no server-backed preview for this
   * content (e.g. a chat blob that was never diverted into a Library
   * artifact), in which case the pane falls back to an honest
   * "unsupported" message rather than rendering raw markup unsandboxed.
   */
  readonly previewSrc?: string;
};

type DocLine =
  | {
      readonly kind: "heading";
      readonly level: 1 | 2 | 3;
      readonly text: string;
    }
  | { readonly kind: "bullet"; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string };

/** Minimal, dependency-free markdown-lite: headings and bullet lists read
 * as structure, everything else is a paragraph. Not a markdown compiler —
 * inline emphasis/links pass through as literal text, which is honest
 * given no markdown-parser dependency is in scope for this phase. */
function parseDocLines(content: string): readonly DocLine[] {
  return content
    .split("\n")
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0)
    .map((line): DocLine => {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading?.[1] !== undefined && heading[2] !== undefined) {
        return {
          kind: "heading",
          level: heading[1].length as 1 | 2 | 3,
          text: heading[2],
        };
      }
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (bullet?.[1] !== undefined) {
        return { kind: "bullet", text: bullet[1] };
      }
      return { kind: "paragraph", text: line };
    });
}

function DocRenderer({ content }: { readonly content: string }) {
  if (content === "") {
    return <EmptyContent message="This document has no content yet." />;
  }
  const lines = parseDocLines(content);
  const HeadingTag = ["h1", "h2", "h3"] as const;
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed text-foreground">
      {lines.map((line, index) => {
        if (line.kind === "heading") {
          const Tag = HeadingTag[line.level - 1] ?? "h3";
          return (
            <Tag key={index} className="font-semibold leading-snug">
              {line.text}
            </Tag>
          );
        }
        if (line.kind === "bullet") {
          return (
            <ul key={index} className="list-disc pl-5">
              <li>{line.text}</li>
            </ul>
          );
        }
        return <p key={index}>{line.text}</p>;
      })}
    </div>
  );
}

function SheetRenderer({ content }: { readonly content: string }) {
  if (content === "") {
    return <EmptyContent message="This sheet has no rows yet." />;
  }
  return <CsvTable text={content} caption="Sheet contents" />;
}

/** No PDF-rendering dependency is in scope for this phase — a page-styled
 * frame around the artifact's stored text is the honest read: it shows
 * whatever text content exists (e.g. an extracted body) without claiming
 * to be a real paginated PDF viewer. */
function PdfRenderer({
  title,
  content,
}: {
  readonly title: string;
  readonly content: string;
}) {
  if (content === "") {
    return (
      <EmptyContent message="No extracted text is stored for this PDF — inline preview isn't available yet." />
    );
  }
  return (
    <div className="rounded-[var(--ui-radius-md)] border border-border bg-card p-6 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {content}
      </p>
    </div>
  );
}

/**
 * Live sandboxed preview of a self-contained HTML artifact. `allow-scripts`
 * with NO `allow-same-origin` puts the framed document in an opaque unique
 * origin: it can run inline script, but it cannot read this app's cookies
 * or storage, call back into the hub API, or navigate the parent — the
 * server's own `Content-Security-Policy: sandbox allow-scripts` header
 * enforces the same posture even if an attribute got stripped somewhere.
 */
function HtmlPreviewRenderer({
  title,
  previewSrc,
}: {
  readonly title: string;
  readonly previewSrc?: string;
}) {
  if (previewSrc === undefined) {
    return (
      <UnsupportedRenderer unavailableReason="No sandboxed preview is available for this HTML artifact yet." />
    );
  }
  return (
    <iframe
      title={`${title} preview`}
      src={previewSrc}
      sandbox="allow-scripts"
      className="h-full min-h-[24rem] w-full border-0"
    />
  );
}

function EmptyContent({ message }: { readonly message: string }) {
  return <p className="text-sm text-muted-foreground">{message}</p>;
}

function UnsupportedRenderer({
  unavailableReason,
}: {
  readonly unavailableReason?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
      <FileQuestion className="size-6" aria-hidden="true" />
      <p>{unavailableReason ?? "No inline preview for this artifact."}</p>
    </div>
  );
}

export function ArtifactRenderer({
  rendererKind,
  title,
  content,
  unavailableReason,
  previewSrc,
}: ArtifactRenderProps) {
  switch (rendererKind) {
    case "doc":
      return <DocRenderer content={content} />;
    case "sheet":
      return <SheetRenderer content={content} />;
    case "pdf":
      return <PdfRenderer title={title} content={content} />;
    case "html":
      return (
        <HtmlPreviewRenderer
          title={title}
          {...(previewSrc !== undefined ? { previewSrc } : {})}
        />
      );
    case "unsupported":
      return (
        <UnsupportedRenderer
          {...(unavailableReason !== undefined ? { unavailableReason } : {})}
        />
      );
  }
}
