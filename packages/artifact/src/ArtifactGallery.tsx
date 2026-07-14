// Stateless artifact gallery. Data fetching lives in the app: callers pass
// the artifacts array plus loading/error flags and selection/action callbacks.
// The kind->viz/fill/span mapping lives in artifact-visuals (presentation is
// kept out of the transport layer).
//
// The gallery is split into two components so the toolbar (title, filters,
// search, sort, view toggle, +Add) can be hoisted into the shared app top bar
// via the page-chrome slot, while ArtifactGallery itself renders only the
// grid/rows body:
//   - ArtifactGalleryToolbar: the header controls, as a standalone component.
//   - ArtifactGallery: the results grid/table + load-more.

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  DataTable,
  ViewToggle,
  type DataTableColumn,
  type ViewMode,
} from "@workbench/ui";
import type { ArtifactWithSession } from "@workbench/shared";
import type { GalleryArtifact } from "./types";
import {
  labelForStatus,
  toGalleryArtifact,
  visualForKind,
} from "./artifact-visuals";
import { ArtifactCard } from "./ArtifactCard";

export interface ArtifactGalleryToolbarProps {
  /** Artifacts backing the item count and the type-filter option list. */
  artifacts: ArtifactWithSession[];
  /** Current search query value. */
  query?: string;
  /** Called when the user changes the search input. */
  onQueryChange?: (query: string) => void;
  /** Bridge to the working intake flow (the "New" action). */
  onNew?: () => void;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
  /** Current sort order. When omitted, the component manages its own state. */
  sort?: "newest" | "oldest";
  /** Called when the user toggles the sort order. */
  onSortChange?: (sort: "newest" | "oldest") => void;
  /** Current owner principal ID filter. Undefined means no filter. */
  ownerPrincipalId?: string;
  /** Called when the user changes the owner filter. */
  onOwnerFilterChange?: (ownerPrincipalId: string | undefined) => void;
  /** Tenant members for the owner filter. Dropdown shows only when two or more are provided. */
  owners?: { id: string; name: string }[];
  /** Current creator-kind filter (human vs agent). Undefined means no filter. */
  creatorKind?: "user" | "agent";
  /** Called when the user changes the creator-kind filter. */
  onCreatorKindFilterChange?: (
    creatorKind: "user" | "agent" | undefined,
  ) => void;
  /** Current artifact-kind filter. Undefined means no filter. */
  kind?: string;
  /** Called when the user changes the kind filter. Dropdown shows only when two or more distinct kinds are present. */
  onKindFilterChange?: (kind: string | undefined) => void;
  /** ISO date (yyyy-mm-dd) lower bound on creation; undefined means no bound. */
  createdAfter?: string;
  /** ISO date (yyyy-mm-dd) upper bound on creation; undefined means no bound. */
  createdBefore?: string;
  /** `source.origin` provenance facet; undefined means all origins. */
  origin?: string;
  /** Called when any advanced filter (date range / origin) changes. */
  onAdvancedFilterChange?: (next: AdvancedArtifactFilter) => void;
  /** Current layout. When omitted, defaults to the grid. */
  viewMode?: ViewMode;
  /** Called when the user toggles between grid and rows. When omitted, the toggle is hidden. */
  onViewModeChange?: (mode: ViewMode) => void;
  /** True while more results exist beyond the currently-loaded set (renders "N+ items"). */
  hasMore?: boolean;
}

export interface ArtifactGalleryProps {
  /** Artifacts to display. Mapped to gallery tiles internally. */
  artifacts: ArtifactWithSession[];
  isLoading?: boolean;
  isError?: boolean;
  /** Current search query value, used only to pick the right empty-state copy. */
  query?: string;
  /** Invoked when a tile is opened. */
  onOpen?: (artifact: GalleryArtifact) => void;
  /** Current layout. When omitted, defaults to the grid. */
  viewMode?: ViewMode;
  /** Opt-in card polish preview. Defaults off so the current grid remains unchanged. */
  experimentalArtifactCards?: boolean;
  /** When true, show a control to load the next cursor page of artifacts. */
  hasMore?: boolean;
  /** Load the next page; paired with `hasMore`. */
  onLoadMore?: () => void;
  /** True while a subsequent page is being fetched. */
  isLoadingMore?: boolean;
  /** Shown under the load-more control when the next page request failed. */
  loadMoreError?: string | null;
}

/** Date-range + provenance facet selection driven by the gallery filter bar. */
export interface AdvancedArtifactFilter {
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  origin?: string | undefined;
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

const artifactRowColumns: DataTableColumn<ArtifactWithSession>[] = [
  {
    key: "title",
    header: "Name",
    className: "font-medium text-text",
    render: (a) => a.title,
  },
  {
    key: "kind",
    header: "Kind",
    render: (a) => visualForKind(a.kind).label,
  },
  {
    key: "owner",
    header: "Owner",
    render: (a) => a.ownerName ?? "—",
  },
  {
    key: "status",
    header: "Status",
    render: (a) => labelForStatus(a.status),
  },
  {
    key: "updated",
    header: "Updated",
    render: (a) => formatUpdated(a.updatedAt),
  },
];

const CREATOR_KIND_LABELS: Record<"user" | "agent", string> = {
  user: "Human",
  agent: "Agent",
};

export function ArtifactGalleryToolbar({
  artifacts,
  query = "",
  onQueryChange,
  onNew,
  onOpenLibrary,
  sort: sortProp,
  onSortChange,
  ownerPrincipalId,
  onOwnerFilterChange,
  owners,
  creatorKind,
  onCreatorKindFilterChange,
  kind: kindFilter,
  onKindFilterChange,
  createdAfter,
  createdBefore,
  onAdvancedFilterChange,
  viewMode = "grid",
  onViewModeChange,
  hasMore = false,
}: ArtifactGalleryToolbarProps) {
  const [internalSort, setInternalSort] = useState<"newest" | "oldest">(
    "newest",
  );
  const sort = sortProp ?? internalSort;

  const hasActiveAdvancedFilter =
    Boolean(createdAfter) || Boolean(createdBefore);
  const [filtersOpen, setFiltersOpen] = useState(hasActiveAdvancedFilter);

  function emitAdvanced(patch: AdvancedArtifactFilter) {
    onAdvancedFilterChange?.({
      createdAfter,
      createdBefore,
      ...patch,
    });
  }

  function handleSortToggle() {
    const next = sort === "newest" ? "oldest" : "newest";
    if (onSortChange) {
      onSortChange(next);
    } else {
      setInternalSort(next);
    }
  }

  const itemCount = artifacts.length;

  // Kinds present in the current (possibly already-filtered) result set, plus
  // the active kind filter itself so a selected-but-now-empty kind stays
  // choosable — otherwise selecting a kind could make the option (and thus a
  // path back to "All types") disappear from its own menu.
  const distinctKinds = [
    ...new Set([
      ...artifacts.map((a) => a.kind),
      ...(kindFilter ? [kindFilter] : []),
    ]),
  ].sort();

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-[10px]">
      {onOpenLibrary && (
        <button
          type="button"
          onClick={onOpenLibrary}
          aria-label="Open library"
          className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text lg:hidden"
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
      <h1 className="shrink-0 text-[15px] font-bold tracking-[-0.02em] text-text">
        Artifacts
      </h1>
      <span className="shrink-0 rounded-[7px] bg-surface-2 px-[9px] py-[3px] font-mono text-[11px] text-text-3">
        {hasMore ? `${itemCount}+` : itemCount} items
      </span>
      {owners && owners.length > 1 && onOwnerFilterChange && (
        <Menu>
          <MenuTrigger className="flex h-[30px] items-center gap-1.5 rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text outline-none focus:border-border-strong data-[state=open]:border-border-strong">
            {owners.find((o) => o.id === ownerPrincipalId)?.name ??
              "All owners"}
            <ChevronDown size={14} className="text-text-3" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => onOwnerFilterChange(undefined)}>
              All owners
            </MenuItem>
            {owners.map((o) => (
              <MenuItem key={o.id} onSelect={() => onOwnerFilterChange(o.id)}>
                {o.name}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      {onCreatorKindFilterChange && (
        <Menu>
          <MenuTrigger className="flex h-[30px] items-center gap-1.5 rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text outline-none focus:border-border-strong data-[state=open]:border-border-strong">
            {creatorKind ? CREATOR_KIND_LABELS[creatorKind] : "All creators"}
            <ChevronDown size={14} className="text-text-3" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => onCreatorKindFilterChange(undefined)}>
              All creators
            </MenuItem>
            <MenuItem onSelect={() => onCreatorKindFilterChange("user")}>
              {CREATOR_KIND_LABELS.user}
            </MenuItem>
            <MenuItem onSelect={() => onCreatorKindFilterChange("agent")}>
              {CREATOR_KIND_LABELS.agent}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
      {onKindFilterChange && distinctKinds.length > 0 && (
        <Menu>
          <MenuTrigger className="flex h-[30px] items-center gap-1.5 rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text outline-none focus:border-border-strong data-[state=open]:border-border-strong">
            {kindFilter ? visualForKind(kindFilter).label : "All types"}
            <ChevronDown size={14} className="text-text-3" />
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => onKindFilterChange(undefined)}>
              All types
            </MenuItem>
            {distinctKinds.map((k) => (
              <MenuItem key={k} onSelect={() => onKindFilterChange(k)}>
                {visualForKind(k).label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
      <input
        type="search"
        placeholder="Search artifacts"
        value={query}
        onChange={(e) => onQueryChange?.(e.target.value)}
        className="h-[30px] w-[160px] rounded-[9px] border border-border bg-transparent px-[11px] text-[12.5px] text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none"
      />
      <button
        type="button"
        onClick={handleSortToggle}
        aria-label={
          sort === "newest" ? "Sort oldest first" : "Sort newest first"
        }
        className="flex items-center gap-[7px] rounded-[9px] border border-border px-[11px] py-[6px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)]"
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
        {sort === "newest" ? "Newest" : "Oldest"}
      </button>
      {onAdvancedFilterChange && (
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-label="Toggle filters"
          className={`flex items-center gap-[7px] rounded-[9px] border px-[11px] py-[6px] text-[12.5px] font-semibold transition-colors hover:border-border-strong hover:bg-[var(--row-hover)] ${
            hasActiveAdvancedFilter
              ? "border-border-strong text-text"
              : "border-border text-text-2"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
          >
            <path d="M3 5h18l-7 8v6l-4-2v-4z" />
          </svg>
          Filters
        </button>
      )}
      {onViewModeChange && (
        <ViewToggle mode={viewMode} onChange={onViewModeChange} />
      )}
      <button
        type="button"
        onClick={onNew}
        className="flex items-center gap-[7px] rounded-[9px] border border-charcoal bg-charcoal px-[11px] py-[6px] text-[12.5px] font-semibold text-cream transition-colors"
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
        Add
      </button>
      {onAdvancedFilterChange && filtersOpen && (
        <div className="flex w-full flex-wrap items-end gap-[14px] border-t border-border pt-[10px]">
          <label className="flex flex-col gap-[5px] text-[11.5px] font-semibold text-text-3">
            From
            <input
              type="date"
              value={createdAfter ?? ""}
              onChange={(e) =>
                emitAdvanced({ createdAfter: e.target.value || undefined })
              }
              className="h-[30px] rounded-[9px] border border-border bg-transparent px-[10px] text-[12.5px] text-text [color-scheme:var(--color-scheme)] focus:border-border-strong focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-[5px] text-[11.5px] font-semibold text-text-3">
            To
            <input
              type="date"
              value={createdBefore ?? ""}
              onChange={(e) =>
                emitAdvanced({ createdBefore: e.target.value || undefined })
              }
              className="h-[30px] rounded-[9px] border border-border bg-transparent px-[10px] text-[12.5px] text-text [color-scheme:var(--color-scheme)] focus:border-border-strong focus:outline-none"
            />
          </label>
          {hasActiveAdvancedFilter && (
            <button
              type="button"
              onClick={() =>
                emitAdvanced({
                  createdAfter: undefined,
                  createdBefore: undefined,
                })
              }
              className="h-[30px] rounded-[9px] border border-border px-[13px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)]"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ArtifactGallery({
  artifacts,
  isLoading = false,
  isError = false,
  query = "",
  onOpen,
  viewMode = "grid",
  experimentalArtifactCards = false,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
  loadMoreError = null,
}: ArtifactGalleryProps) {
  const tiles = artifacts.map(toGalleryArtifact);
  const isSearching = query.trim().length > 0;

  return (
    <section className="flex min-h-full flex-col">
      <div className="flex-1 px-4 pb-10 pt-4 sm:px-7 [container-type:inline-size]">
        {isLoading && (
          <div className="py-10 text-[13px] text-text-3">
            Loading artifacts…
          </div>
        )}
        {isError && (
          <div className="py-10 text-[13px] text-text-3">
            Could not load artifacts.
          </div>
        )}
        {!isLoading && !isError && tiles.length === 0 && !isSearching && (
          <div className="py-10 text-[13px] text-text-3">
            No artifacts yet. Start a job to generate collateral.
          </div>
        )}
        {!isLoading && !isError && tiles.length === 0 && isSearching && (
          <div className="py-10 text-[13px] text-text-3">
            No results for &ldquo;{query.trim()}&rdquo;.
          </div>
        )}
        {viewMode === "rows" ? (
          <DataTable<ArtifactWithSession>
            caption="Artifacts"
            rows={artifacts}
            getRowKey={(a) => a.id}
            {...(onOpen
              ? { onRowClick: (a) => onOpen(toGalleryArtifact(a)) }
              : {})}
            columns={artifactRowColumns}
          />
        ) : (
          <div className="grid auto-rows-[88px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-[var(--gap)] sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
            {tiles.map((tile, i) => (
              <ArtifactCard
                key={tile.id}
                artifact={tile}
                index={i + 1}
                experimental={experimentalArtifactCards}
                {...(onOpen ? { onOpen } : {})}
              />
            ))}
          </div>
        )}
        {hasMore && onLoadMore && (
          <div className="flex flex-col items-center gap-2 pt-6">
            {loadMoreError ? (
              <p className="text-center text-[13px] text-text-3">
                {loadMoreError}
              </p>
            ) : null}
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isLoadingMore}
              className="rounded-[9px] border border-border px-[18px] py-[9px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)] disabled:opacity-50"
            >
              {isLoadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
