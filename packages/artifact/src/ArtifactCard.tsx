// A single gallery tile. Stateless: it renders a pre-computed GalleryArtifact
// and reports clicks via onOpen. No data fetching, no selection state.

import type { GalleryArtifact } from "./types";
import { ArtifactViz } from "./ArtifactViz";

interface ArtifactCardProps {
  artifact: GalleryArtifact;
  /** 1-based position in the grid, used for the decorative code badge. */
  index: number;
  /** Invoked when the card is activated (click / Enter / Space). */
  onOpen?: ((artifact: GalleryArtifact) => void) | undefined;
}

export function ArtifactCard({ artifact, index, onOpen }: ArtifactCardProps) {
  const open = onOpen ? () => onOpen(artifact) : undefined;
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
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-surface transition-transform duration-300 ease-spring hover:-translate-y-1.5 hover:rotate-[-1deg] hover:scale-[1.02] hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-orange ${artifact.span}`}
    >
      <span className="absolute left-[10px] top-[10px] z-[2] rounded-full bg-[rgba(0,0,0,0.32)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.03em] text-white backdrop-blur-[6px]">
        {artifact.label}
      </span>
      <div
        className={`relative grid flex-1 place-items-center overflow-hidden ${artifact.fill}`}
      >
        <div className="h-full w-full transition-transform duration-500 ease-spring group-hover:scale-[1.06]">
          <ArtifactViz kind={artifact.viz} />
        </div>
        <span className="absolute bottom-[10px] right-3 font-mono text-[13px] font-bold text-[rgba(255,255,255,0.85)]">
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
        {artifact.provenanceTone !== "unknown" && (
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
