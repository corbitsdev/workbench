// A single gallery tile. Stateless: it renders a pre-computed GalleryArtifact
// and reports clicks via onOpen. No data fetching, no selection state.

import type { GalleryArtifact } from "./types";
import { ArtifactCardPreview } from "./ArtifactCardPreview";
import {
  artifactPreviewFamily,
  labelForArtifactStatus,
} from "./artifact-preview-family";
import { iconForPreviewFamily } from "./artifact-family-icon";

interface ArtifactCardProps {
  artifact: GalleryArtifact;
  /** 1-based position in the grid, used for the decorative code badge. */
  index: number;
  /** Invoked when the card is activated (click / Enter / Space). */
  onOpen?: ((artifact: GalleryArtifact) => void) | undefined;
  experimental?: boolean | undefined;
}

function statusChipClass(status: GalleryArtifact["status"]): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
    case "rejected":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
    default:
      return "bg-surface-2 text-text-3";
  }
}

export function ArtifactCard({
  artifact,
  index,
  onOpen,
  experimental = false,
}: ArtifactCardProps) {
  const open = onOpen ? () => onOpen(artifact) : undefined;
  const fill = experimental
    ? (artifact.experimentalFill ?? artifact.fill)
    : artifact.fill;
  const span = experimental
    ? (artifact.experimentalSpan ?? artifact.span)
    : artifact.span;
  const family = artifactPreviewFamily(artifact.kind);
  const FamilyIcon = iconForPreviewFamily(family);
  const cardMotion =
    "shadow-sm transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:border-border-strong hover:shadow-md";
  return (
    <div
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      aria-label={open ? `Open ${artifact.title}` : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-orange ${cardMotion} ${span}`}
      data-preview-family={family}
    >
      <span className="absolute left-[10px] top-[10px] z-[2] inline-flex max-w-[calc(100%-24px)] items-center gap-1 rounded-full bg-[rgba(18,18,18,0.58)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        <FamilyIcon className="h-3 w-3 shrink-0 opacity-90" aria-hidden />
        <span className="truncate">{artifact.label}</span>
      </span>
      <span
        className={`absolute right-[10px] top-[10px] z-[2] rounded-full px-2 py-[3px] text-[10px] font-semibold tracking-[0.02em] backdrop-blur-[6px] ${statusChipClass(artifact.status)}`}
      >
        {labelForArtifactStatus(artifact.status)}
      </span>
      <div
        className={`relative min-h-[120px] flex-1 overflow-hidden bg-background/40 ${fill} bg-opacity-20`}
      >
        <div className="h-full w-full transition-transform duration-300 ease-out group-hover:scale-[1.02]">
          <ArtifactCardPreview
            family={family}
            fill={fill}
            {...(artifact.previewExcerpt === undefined
              ? {}
              : { excerpt: artifact.previewExcerpt })}
          />
        </div>
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-white drop-shadow-sm">
          {artifact.label[0]}
          {index.toString().padStart(2, "0")}
        </span>
      </div>
      <div className="border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="truncate text-[13.5px] font-semibold text-text">
          {artifact.title}
        </div>
        <div className="mt-0.5 flex items-center gap-[7px] font-mono text-[11px] text-text-3">
          <span>{artifact.from}</span>·<span>{artifact.time}</span>
        </div>
        {(artifact.provenanceTone ?? "origin") !== "unknown" && (
          <div className="mt-1">
            <span
              className={`inline-flex max-w-full items-center truncate rounded-sm bg-surface-2 px-2 py-0.5 text-[10px] font-semibold tracking-[0.03em] text-text-3 ${
                artifact.provenanceTone === "free" ? "" : "uppercase"
              }`}
            >
              {artifact.provenance}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
