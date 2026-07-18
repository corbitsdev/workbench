// Thin data wrapper around the stateless @workbench/artifact gallery. This is
// the only place the gallery is bound to transport: it fetches artifacts via
// @workbench/client and passes the array + flags into the package component.
// Presentation, layout, and tile mapping all live in @workbench/artifact.

import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { useExperimentalArtifactCards, useViewMode } from "@workbench/ui";
import {
  artifactsInfiniteQueryKey,
  useArchiveArtifact,
  useArtifactsInfinite,
  useTenantMembers,
} from "@workbench/client/react";
import type { UseArtifactsParams } from "@workbench/client/react";
import type { ArtifactsPage } from "@workbench/client";
import { getMe } from "../../lib/hub-api";
import { useActiveWorkbench } from "../../lib/active-workbench-context";
import {
  ArtifactGallery as ArtifactGalleryView,
  ArtifactGalleryToolbar,
  ArtifactModal,
} from "@workbench/artifact";
import type {
  GalleryArtifact,
  ArtifactWithSession,
  AdvancedArtifactFilter,
} from "@workbench/artifact";
import { clientOptions } from "../../lib/client-options";
import ArtifactBody, { isImageUpload } from "../ArtifactBody";
import { AddArtifactModal } from "../AddArtifactModal";
import { resolveKindLabel } from "../../lib/resolve-kind-label";
import { canUseArtifactInWorkflow } from "@workbench/artifact";
import { useChatLauncher } from "../../lib/chat-launcher-context";
import { buildArtifactMessage } from "../../lib/artifact-chat-message";
import { buildSameOriginApiUrl } from "../../lib/api";
import { useSetPageChrome } from "../../lib/page-chrome";

export { buildArtifactMessage };

const SEARCH_DEBOUNCE_MS = 300;

// An image renders a gallery thumbnail whether its bytes live in the upload
// table (direct upload, `source.upload.id` present) or as a data: URL with no
// upload row (chat-imported via parse-file, CL-3906) — the download route
// serves both. A legacy kind-"file" row with an image upload mime (imported
// before the CL-3906 fix) gets the same thumbnail via `isImageUpload`, the
// same detection ArtifactBody's inline-preview fallback uses.
function imageThumbnailUrl(artifact: ArtifactWithSession): string | undefined {
  const isImage =
    artifact.kind === "image" ||
    (artifact.kind === "file" && isImageUpload(artifact.source));
  if (!isImage) return undefined;
  return buildSameOriginApiUrl(`/artifacts/${artifact.id}/download`);
}

interface ArtifactGalleryProps {
  /** Active workbench tenant. Null means workbench context is still loading. */
  tenantId?: string | null;
  /** When provided, renders a mobile-only control to open the library overlay. */
  onOpenLibrary?: () => void;
  /** Open the workflow catalog seeded with this artifact (owned by the page). */
  onUseInWorkflow?: (artifact: ArtifactWithSession) => void;
  /**
   * When provided, opening an artifact calls this (e.g. navigate to a full-page
   * artifact view) instead of the built-in preview modal.
   */
  onOpenArtifact?: (artifact: ArtifactWithSession) => void;
}

export function ArtifactGallery({
  tenantId,
  onOpenLibrary,
  onUseInWorkflow,
  onOpenArtifact,
}: ArtifactGalleryProps) {
  const { openWithMessage } = useChatLauncher();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeWorkbench } = useActiveWorkbench();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 5 * 60_000,
  });
  const archiveMutation = useArchiveArtifact(clientOptions);
  const [inputQuery, setInputQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined);
  const [creatorKindFilter, setCreatorKindFilter] = useState<
    "user" | "agent" | undefined
  >(undefined);
  const [kindFilter, setKindFilter] = useState<string | undefined>(undefined);
  const [archiveError, setArchiveError] = useState(false);
  const [advancedFilter, setAdvancedFilter] = useState<AdvancedArtifactFilter>(
    {},
  );
  const [addOpen, setAddOpen] = useState(false);
  const { mode: viewMode, setMode: setViewMode } = useViewMode("artifacts");
  const { enabled: experimentalArtifactCards } = useExperimentalArtifactCards();

  const {
    artifacts,
    isLoading,
    isError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    error: artifactsQueryError,
  } = useArtifactsInfinite(clientOptions, {
    tenantId,
    query: debouncedQuery || undefined,
    sort,
    ownerPrincipalId: ownerFilter,
    creatorKind: creatorKindFilter,
    kind: kindFilter,
    createdAfter: advancedFilter.createdAfter,
    createdBefore: advancedFilter.createdBefore,
  });

  const { data: members } = useTenantMembers(clientOptions, { tenantId });

  const [selected, setSelected] = useState<ArtifactWithSession | null>(null);

  // Owner-or-admin gate for the archive action. The server re-checks this; the
  // gate here only decides whether to offer the button. `activeWorkbench.id` is
  // the caller's principal id in the active tenant.
  const myPrincipalId = activeWorkbench?.id ?? null;
  const isAdmin = meQuery.data?.isAdmin === true;
  const isOwner = meQuery.data?.isOwner === true;
  function canArchive(artifact: ArtifactWithSession): boolean {
    if (isAdmin || isOwner) return true;
    return (
      artifact.ownerPrincipalId !== null &&
      artifact.ownerPrincipalId === myPrincipalId
    );
  }

  // The infinite query key for the current filter set — used to optimistically
  // drop the archived card and to roll it back if the request fails.
  const currentListParams: UseArtifactsParams = {
    tenantId,
    query: debouncedQuery || undefined,
    sort,
    ownerPrincipalId: ownerFilter,
    creatorKind: creatorKindFilter,
    kind: kindFilter,
    createdAfter: advancedFilter.createdAfter,
    createdBefore: advancedFilter.createdBefore,
  };

  function handleArchive(artifact: ArtifactWithSession) {
    setSelected(null);
    setArchiveError(false);
    const key = artifactsInfiniteQueryKey(currentListParams);
    const previous =
      queryClient.getQueryData<InfiniteData<ArtifactsPage, string | null>>(key);
    if (previous) {
      queryClient.setQueryData<InfiniteData<ArtifactsPage, string | null>>(
        key,
        {
          ...previous,
          pages: previous.pages.map((page) => ({
            ...page,
            artifacts: page.artifacts.filter((a) => a.id !== artifact.id),
          })),
        },
      );
    }
    archiveMutation
      .mutateAsync({ artifactId: artifact.id, tenantId })
      .catch(() => {
        if (previous) queryClient.setQueryData(key, previous);
        setArchiveError(true);
      });
  }

  const handleQueryChange = useCallback((value: string) => {
    setInputQuery(value);
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      setDebouncedQuery(value);
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  const handleOpen = (gallery: GalleryArtifact) => {
    const full = (artifacts ?? []).find((a) => a.id === gallery.id) ?? null;
    if (onOpenArtifact && full) {
      onOpenArtifact(full);
      return;
    }
    setSelected(full);
  };

  function handleOpenInMyra(artifact: ArtifactWithSession) {
    if (artifact.id === "") {
      throw new Error("Cannot open an artifact with an empty id in Myra");
    }
    openWithMessage(buildArtifactMessage(artifact, tenantId ?? undefined));
    setSelected(null);
  }

  function handleUseInWorkflow(artifact: ArtifactWithSession) {
    onUseInWorkflow?.(artifact);
    setSelected(null);
  }

  // `/insights/trace/:runId` resolves a `workflow_run_record` id (see
  // WorkflowTracePage). `ArtifactWithSession.sessionId` is emitted as null by
  // the hub today (session enrichment is not wired up — see artifacts.ts), so
  // this destination is unverified: re-check it resolves a real run once the
  // hub starts populating sessionId, rather than assuming the old pre-M6
  // "session" concept lines up with a workflow_run_record id.
  function handleOpenSession(sessionId: string) {
    setSelected(null);
    navigate(`/insights/trace/${sessionId}`);
  }

  function handleOpenParent(parentId: string) {
    setSelected(null);
    navigate(`/artifacts/${parentId}`);
  }

  // The mutation invalidates the artifact list, so the new row refetches into
  // the gallery. Clear any active search/filters so it is guaranteed visible
  // rather than hidden behind a stale facet.
  function handleArtifactCreated(_artifactId: string) {
    setInputQuery("");
    setDebouncedQuery("");
    setOwnerFilter(undefined);
    setCreatorKindFilter(undefined);
    setKindFilter(undefined);
    setAdvancedFilter({});
  }

  const toolbar = useMemo(
    () => (
      <ArtifactGalleryToolbar
        artifacts={artifacts ?? []}
        query={inputQuery}
        onQueryChange={handleQueryChange}
        onNew={() => setAddOpen(true)}
        onOpenLibrary={onOpenLibrary}
        sort={sort}
        onSortChange={setSort}
        ownerPrincipalId={ownerFilter}
        onOwnerFilterChange={setOwnerFilter}
        owners={members}
        creatorKind={creatorKindFilter}
        onCreatorKindFilterChange={setCreatorKindFilter}
        kind={kindFilter}
        onKindFilterChange={setKindFilter}
        createdAfter={advancedFilter.createdAfter}
        createdBefore={advancedFilter.createdBefore}
        onAdvancedFilterChange={setAdvancedFilter}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        hasMore={hasNextPage === true}
      />
    ),
    [
      artifacts,
      inputQuery,
      handleQueryChange,
      setAddOpen,
      onOpenLibrary,
      sort,
      setSort,
      ownerFilter,
      setOwnerFilter,
      members,
      creatorKindFilter,
      setCreatorKindFilter,
      kindFilter,
      setKindFilter,
      advancedFilter,
      setAdvancedFilter,
      viewMode,
      setViewMode,
      hasNextPage,
    ],
  );
  useSetPageChrome(toolbar);

  return (
    <>
      {archiveError && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-center justify-between gap-3 rounded border border-red-soft bg-red-soft/20 px-3 py-2 text-sm text-red"
        >
          <span>
            Couldn&apos;t archive that artifact — it&apos;s still here. Try
            again.
          </span>
          <button
            type="button"
            onClick={() => setArchiveError(false)}
            className="text-xs text-text-3 hover:text-text"
          >
            Dismiss
          </button>
        </div>
      )}
      <ArtifactGalleryView
        artifacts={artifacts ?? []}
        isLoading={isLoading}
        isError={isError}
        query={inputQuery}
        onOpen={handleOpen}
        viewMode={viewMode}
        experimentalArtifactCards={experimentalArtifactCards}
        hasMore={hasNextPage === true}
        onLoadMore={() => {
          void fetchNextPage();
        }}
        isLoadingMore={isFetchingNextPage}
        loadMoreError={
          isFetchNextPageError
            ? (artifactsQueryError?.message ?? "Could not load more artifacts.")
            : null
        }
        thumbnailUrlForArtifact={imageThumbnailUrl}
      />
      <ArtifactModal
        open={selected !== null}
        artifact={selected}
        onClose={() => setSelected(null)}
        kindLabel={selected ? resolveKindLabel(selected.kind) : undefined}
        onOpenInMyra={handleOpenInMyra}
        onUseInWorkflow={onUseInWorkflow ? handleUseInWorkflow : undefined}
        onArchive={selected && canArchive(selected) ? handleArchive : undefined}
        canUseInWorkflow={(a) => canUseArtifactInWorkflow(a.kind)}
        onOpenSession={handleOpenSession}
        onOpenParent={handleOpenParent}
      >
        {selected && <ArtifactBody artifact={selected} />}
      </ArtifactModal>
      <AddArtifactModal
        open={addOpen}
        tenantId={tenantId}
        onClose={() => setAddOpen(false)}
        onCreated={handleArtifactCreated}
      />
    </>
  );
}
