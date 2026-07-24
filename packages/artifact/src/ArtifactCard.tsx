// A single gallery tile. Stateless: it renders a pre-computed GalleryArtifact
// and reports clicks via onOpen. No data fetching, no selection state.

import type { GalleryArtifact } from "./types";
import { ArtifactCardPreview } from "./ArtifactCardPreview";
import { artifactPreviewFamily } from "./artifact-preview-family";

interface ArtifactCardProps {
  artifact: GalleryArtifact;
  /** Invoked when the card is activated (click / Enter / Space). */
  onOpen?: ((artifact: GalleryArtifact) => void) | undefined;
  experimental?: boolean | undefined;
}

export function ArtifactCard({
  artifact,
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
      {artifact.creatorInitials ? (
        <div
          className="absolute left-[10px] top-[10px] z-[2] flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(18,18,18,0.72)] text-[9px] font-bold uppercase tracking-[0.02em] text-white backdrop-blur-[6px]"
          aria-label={`Created by ${artifact.creatorInitials}`}
          title={`Created by ${artifact.creatorInitials}`}
        >
          {artifact.creatorInitials}
        </div>
      ) : null}
      <div
        className={`relative min-h-[120px] flex-1 overflow-hidden ${experimental ? `bg-surface/40 ${fill} bg-opacity-20` : fill}`}
      >
        <div className="flex h-full w-full items-center justify-center transition-transform duration-300 ease-out group-hover:scale-[1.02]">
          <ArtifactCardPreview
            family={family}
            fill={fill}
            {...(artifact.previewExcerpt === undefined
              ? {}
              : { excerpt: artifact.previewExcerpt })}
            {...(artifact.thumbnailUrl === undefined
              ? {}
              : { thumbnailUrl: artifact.thumbnailUrl })}
            {...(artifact.thumbnailAlt === undefined
              ? {}
              : { thumbnailAlt: artifact.thumbnailAlt })}
          />
        </div>
      </div>
      <div className="flex min-h-[68px] flex-col justify-center border-t border-border bg-surface px-[13px] py-[11px]">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text">
            {artifact.title}
          </div>
        </div>
        {(artifact.from ?? artifact.time) ? (
          <div className="mt-0.5 flex items-center gap-[7px] font-mono text-[11px] text-text-3">
            {artifact.from ? <span>{artifact.from}</span> : null}
            {artifact.from && artifact.time ? <span>·</span> : null}
            {artifact.time ? <span>{artifact.time}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
