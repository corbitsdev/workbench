// Dense library card: kind badge, title, optional snippet, and a meta
// line (owner · source · size · updated). Pure presentational — the page
// owns selection and preview.

import { Badge, formatRelativeTime } from "@corbits/react-ui";
import type { ReactNode } from "react";

import type { ArtifactSummary } from "./types";

export type ArtifactCardMeta = {
  readonly sourceChannel?: string | null;
  readonly sizeLabel?: string | null;
  readonly snippet?: string | null;
};

export type ArtifactCardProps = {
  readonly artifact: ArtifactSummary;
  readonly meta?: ArtifactCardMeta;
  readonly selected?: boolean;
  readonly now?: number | undefined;
  readonly onSelect?: () => void;

  readonly trailing?: ReactNode;
};

function metaLine(
  artifact: ArtifactSummary,
  meta: ArtifactCardMeta | undefined,
  now: number | undefined,
): string {
  const parts: string[] = [];
  if (artifact.ownerName !== null && artifact.ownerName !== "") {
    parts.push(artifact.ownerName);
  }
  if (meta?.sourceChannel !== undefined && meta.sourceChannel !== null) {
    parts.push(meta.sourceChannel);
  }
  if (meta?.sizeLabel !== undefined && meta.sizeLabel !== null) {
    parts.push(meta.sizeLabel);
  }
  const when = formatRelativeTime(
    artifact.updatedAt ?? artifact.createdAt,
    now,
  );
  if (when !== "") parts.push(when);
  return parts.join(" · ");
}

export function ArtifactCard({
  artifact,
  meta,
  selected = false,
  now,
  onSelect,
  trailing,
}: ArtifactCardProps) {
  const line = metaLine(artifact, meta, now);
  const snippet = meta?.snippet;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors",
        selected
          ? "border-primary ring-1 ring-primary/40"
          : "border-border hover:border-primary/40",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <Badge tone="access" className="font-mono text-[0.65rem] uppercase tracking-wide">
          {artifact.kind}
        </Badge>
        {trailing}
      </div>
      <span className="truncate text-sm font-semibold leading-snug">
        {artifact.title}
      </span>
      {snippet !== undefined && snippet !== null && snippet !== "" ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {snippet}
        </span>
      ) : null}
      {line !== "" ? (
        <span className="truncate text-[0.7rem] text-muted-foreground">
          {line}
        </span>
      ) : null}
    </button>
  );
}
