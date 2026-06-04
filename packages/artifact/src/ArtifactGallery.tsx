// Stateless artifact gallery grid. Data fetching lives in the app: callers pass
// the artifacts array plus loading/error flags and selection/action callbacks.
// The kind->viz/fill/span mapping lives in artifact-visuals (presentation is
// kept out of the transport layer). This renders the grid and header only.

import type { ArtifactWithSession } from '@workbench/shared';
import type { GalleryArtifact } from './types';
import { toGalleryArtifact } from './artifact-visuals';
import { ArtifactCard } from './ArtifactCard';

export interface ArtifactGalleryProps {
  /** Artifacts to display. Mapped to gallery tiles internally. */
  artifacts: ArtifactWithSession[];
  isLoading?: boolean;
  isError?: boolean;
  /** Invoked when a tile is opened. */
  onOpen?: (artifact: GalleryArtifact) => void;
  /** Bridge to the working intake flow (the "New" action). */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
}

export function ArtifactGallery({
  artifacts,
  isLoading = false,
  isError = false,
  onOpen,
  onNew,
  onOpenLibrary,
}: ArtifactGalleryProps) {
  const tiles = artifacts.map(toGalleryArtifact);

  return (
    <section className="flex min-h-full flex-col rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]">
      <div className="flex items-center gap-[14px] px-4 pb-[14px] pt-5 sm:px-7">
        {onOpenLibrary && (
          <button
            type="button"
            onClick={onOpenLibrary}
            aria-label="Open library"
            className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-[18px] w-[18px]"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <h1 className="text-[21px] font-bold tracking-[-0.02em] text-text">Artifacts</h1>
        <span className="rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[12px] text-text-3">
          {tiles.length} items
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-[7px] rounded-[9px] border border-border px-[13px] py-[7px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)]"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-3.5 w-3.5"
          >
            <path d="M3 6h18M6 12h12M10 18h4" />
          </svg>
          Sort
        </button>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-[7px] rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[7px] text-[12.5px] font-semibold text-cream transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-3.5 w-3.5"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>

      <div className="flex-1 px-4 pb-10 pt-1.5 sm:px-7 [container-type:inline-size]">
        {isLoading && <div className="py-10 text-[13px] text-text-3">Loading artifacts…</div>}
        {isError && <div className="py-10 text-[13px] text-text-3">Could not load artifacts.</div>}
        {!isLoading && !isError && tiles.length === 0 && (
          <div className="py-10 text-[13px] text-text-3">
            No artifacts yet. Start a session to generate collateral.
          </div>
        )}
        <div className="grid auto-rows-[88px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
          {tiles.map((tile, i) => (
            <ArtifactCard
              key={tile.id}
              artifact={tile}
              index={i + 1}
              {...(onOpen ? { onOpen } : {})}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
