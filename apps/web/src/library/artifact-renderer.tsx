// Every host renders through this one component so a kind's shape only
// has one implementation. Read-only phase: no editing affordances here.

import { CsvTable } from "@corbits/react-ui";
import { FileDashed } from "@/lib/icons";
import type { ArtifactRendererKind } from "./renderer-kind";

export type ArtifactRenderProps = {
  readonly rendererKind: ArtifactRendererKind;
  readonly title: string;
  // Empty string is a legitimate "nothing here" — never distinguished
  // from "not fetched yet", which the host's loading state handles first.
  readonly content: string;
  // True when `content` is empty because the real bytes are out-of-band
  // and undecodable, not because the artifact is genuinely blank — swaps
  // in an honest "couldn't read this file" message instead.
  readonly contentUnavailable?: boolean;
  readonly unavailableReason?: string;
  // Absent when the host has no server-backed preview, in which case the
  // pane falls back to "unsupported" rather than rendering raw markup
  // unsandboxed.
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

// Not a markdown compiler — inline emphasis/links pass through as
// literal text.
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

function DocRenderer({
  content,
  contentUnavailable,
}: {
  readonly content: string;
  readonly contentUnavailable: boolean;
}) {
  if (content === "") {
    return (
      <EmptyContent
        message={
          contentUnavailable
            ? "We couldn't read this file's contents for preview."
            : "This document has no content yet."
        }
      />
    );
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

function SheetRenderer({
  content,
  contentUnavailable,
}: {
  readonly content: string;
  readonly contentUnavailable: boolean;
}) {
  if (content === "") {
    return (
      <EmptyContent
        message={
          contentUnavailable
            ? "We couldn't read this file's contents for preview."
            : "This sheet has no rows yet."
        }
      />
    );
  }
  return <CsvTable text={content} caption="Sheet contents" />;
}

// No PDF-rendering dependency in scope — shows the stored text honestly
// without claiming to be a real paginated viewer.
function PdfRenderer({
  title,
  content,
  contentUnavailable,
}: {
  readonly title: string;
  readonly content: string;
  readonly contentUnavailable: boolean;
}) {
  if (content === "") {
    return (
      <EmptyContent
        message={
          contentUnavailable
            ? "We couldn't read this file's contents for preview."
            : "No extracted text is stored for this PDF — inline preview isn't available yet."
        }
      />
    );
  }
  return (
    <div className="rounded-[var(--ui-radius-md)] border border-border bg-card p-6 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{content}</p>
    </div>
  );
}

// `allow-scripts` with NO `allow-same-origin`: the framed document runs
// inline script but can't read this app's cookies/storage or call the hub
// API. The server's CSP header enforces the same posture as a backstop.
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

function UnsupportedRenderer({ unavailableReason }: { readonly unavailableReason?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
      <FileDashed className="size-6" aria-hidden="true" />
      <p>{unavailableReason ?? "No inline preview for this artifact."}</p>
    </div>
  );
}

export function ArtifactRenderer({
  rendererKind,
  title,
  content,
  contentUnavailable,
  unavailableReason,
  previewSrc,
}: ArtifactRenderProps) {
  switch (rendererKind) {
    case "doc":
      return <DocRenderer content={content} contentUnavailable={contentUnavailable ?? false} />;
    case "sheet":
      return <SheetRenderer content={content} contentUnavailable={contentUnavailable ?? false} />;
    case "pdf":
      return (
        <PdfRenderer
          title={title}
          content={content}
          contentUnavailable={contentUnavailable ?? false}
        />
      );
    case "html":
      return (
        <HtmlPreviewRenderer title={title} {...(previewSrc !== undefined ? { previewSrc } : {})} />
      );
    case "unsupported":
      return (
        <UnsupportedRenderer {...(unavailableReason !== undefined ? { unavailableReason } : {})} />
      );
  }
}
