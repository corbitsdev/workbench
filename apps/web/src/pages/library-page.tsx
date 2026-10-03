import {
  BulkActionBar,
  Button,
  RichEmptyState,
  SelectionCheckbox,
  Skeleton,
  artifactKindLabel,
  formatRelativeTime,
  useListSelection,
} from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import type { UseListSelectionResult } from "@corbits/react-ui";
import {
  ArtifactRenderer,
  artifactMatchesLibraryKindSegment,
  filterArtifacts,
  isTextDecodableMediaType,
  libraryArtifactIdFromPath,
  libraryKindSegmentFromPath,
  resolveArtifactRendererKind,
  sortArtifacts,
  workflowRunIdFromSource,
} from "@/library";
import type { ArtifactSummary } from "@/library";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowSquareOut, LinkSimple as LinkIcon, Stack, X } from "@/lib/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { describeApiError, ListSkeleton, QueryView, SignedOutNotice } from "@/lib/api-query";

import {
  artifactPreviewPath,
  ArtifactDetailSchema,
  ArtifactListPageSchema,
  useAPIQuery,
  type ArtifactDetail,
} from "../api";
import { isAdditiveSelectClick, isRowActivationKey } from "../activatable-row";
import { useBench } from "../bench-context";
import { ListCard, ListFilter } from "./library-list";
import { readLastWorkbenchId } from "../last-workbench";
import { consumePendingLibraryUpload, LIBRARY_UPLOAD_EVENT } from "../library-upload";
import { resolveLibraryWorkbenchScope } from "../library-workbench-scope";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import { useBenchActivity } from "../shell/bench-activity";
import { useFromBench } from "../shell/page-crumbs";
import {
  artifactUploadToast,
  copyArtifactLinks,
  copyArtifactLinksActionLabel,
  copyArtifactLinksToastLabel,
  isArtifactsUnavailableStatus,
  LIBRARY_BULK_OPERATION_IDS,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
  uploadMimeTypeFromSource,
} from "../shell/library-artifacts";
import { PageLayout } from "../shell/page-layout";
import { StageTopBar } from "../shell/stage-top-bar";
import "./library-page.css";

function ArtifactRows({
  artifacts,
  now,
  selectedId,
  onSelect,
  selection,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now: number | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly selection: UseListSelectionResult<string>;
}) {
  // `useListSelection` hands back ids in toggle order, not row order — a
  // bottom-up shift-select would otherwise copy links out of visible order.
  const visibleOrder = useMemo(
    () => new Map(artifacts.map((artifact, index) => [artifact.id, index])),
    [artifacts],
  );

  return (
    <ListCard
      label="Artifacts"
      columns="minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 0.8fr) auto"
      heads={["Name", "From", "Updated", ""]}
    >
      {artifacts.map((artifact) => {
        const isSelected = selection.isSelected(artifact.id);
        const selectionIds =
          isSelected && selection.selectedCount > 1
            ? [...selection.selectedIds].sort(
                (a, b) => (visibleOrder.get(a) ?? 0) - (visibleOrder.get(b) ?? 0),
              )
            : [artifact.id];
        return (
          <li
            key={artifact.id}
            className="lib-row"
            data-link
            data-state={selectedId === artifact.id ? "selected" : undefined}
            data-ctx-artifact={artifact.id}
            data-ctx-artifact-selected-ids={selectionIds.join(",")}
            role="button"
            tabIndex={0}
            onClick={(event: ReactMouseEvent) => {
              if (event.shiftKey || isAdditiveSelectClick(event)) {
                selection.toggle(artifact.id, { shiftKey: event.shiftKey });
                return;
              }
              onSelect(artifact.id);
            }}
            onKeyDown={(event) => {
              if (!isRowActivationKey(event.key)) return;
              event.preventDefault();
              onSelect(artifact.id);
            }}
          >
            <span className="lib-cell lib-name">{artifact.title}</span>
            <span className="lib-cell lib-cell--soft">{artifact.from ?? "—"}</span>
            <span className="lib-cell">
              {formatRelativeTime(artifact.updatedAt ?? artifact.createdAt, now)}
            </span>
            <span className="lib-cell lib-cell--end" onClick={(event) => event.stopPropagation()}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onSelect(artifact.id)}
              >
                Preview
              </Button>
              <SelectionCheckbox
                checked={isSelected}
                onToggle={(modifiers) => selection.toggle(artifact.id, modifiers)}
                rowLabel={artifact.title}
              />
            </span>
          </li>
        );
      })}
    </ListCard>
  );
}

// Not a lineage system — every other origin renders nothing rather than
// guessing.
function ProvenanceLine({ source }: { readonly source: Record<string, unknown> }) {
  const runId = workflowRunIdFromSource(source);
  if (runId === null) return null;
  return (
    <p className="lib-source">
      <Link to={`/insights/runs/${encodeURIComponent(runId)}`} className="lib-source-link">
        Produced by workflow run
      </Link>
    </p>
  );
}

function PreviewPane({
  tenantId,
  detail,
  loading,
  error,
  onClose,
}: {
  readonly tenantId: string | null;
  readonly detail: ArtifactDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
}) {
  const rendererKind = detail !== null ? resolveArtifactRendererKind(detail) : null;
  const previewSrc =
    detail !== null && rendererKind === "html" && tenantId !== null
      ? artifactPreviewPath(tenantId, detail.id)
      : undefined;
  // Empty `content` is ambiguous alone (honest "nothing here" vs. a real
  // upload whose bytes aren't text-decodable); `uploadMimeType`
  // disambiguates.
  const uploadMimeType = detail !== null ? uploadMimeTypeFromSource(detail.source) : null;
  const contentUnavailable =
    detail !== null &&
    detail.content === "" &&
    uploadMimeType !== null &&
    !isTextDecodableMediaType(uploadMimeType);
  return (
    <aside className="lib-preview">
      <div className="lib-preview-head">
        <div className="lib-preview-titles">
          <p className="lib-preview-title">{detail?.title ?? "Preview"}</p>
          {detail !== null ? (
            <p className="lib-preview-meta">
              {artifactKindLabel(detail.kind)}
              {` · Version ${detail.version}`}
            </p>
          ) : null}
          {detail !== null ? <ProvenanceLine source={detail.source} /> : null}
        </div>
        <div className="lib-preview-actions">
          {previewSrc !== undefined ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={previewSrc} target="_blank" rel="noreferrer">
                <ArrowSquareOut aria-hidden="true" />
                Open in new tab
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="lib-preview-body">
        {loading ? <Skeleton className="skeleton-panel" /> : null}
        {error !== null ? (
          <p className="page-error" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && error === null && detail !== null && rendererKind !== null ? (
          <ArtifactRenderer
            rendererKind={rendererKind}
            title={detail.title}
            content={detail.content}
            contentUnavailable={contentUnavailable}
            {...(previewSrc !== undefined ? { previewSrc } : {})}
          />
        ) : null}
      </div>
    </aside>
  );
}

export function LibraryPage({
  artifacts,
  now,
  onUpload,
  uploading,
  uploadError,
  query,
  onQueryChange,
  selectedId = null,
  onSelect,
  preview = null,
  previewLoading = false,
  previewError = null,
  tenantId = null,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now?: number;
  readonly onUpload?: (files: readonly File[]) => void;
  readonly uploading?: boolean;
  readonly uploadError?: string | null;
  readonly query?: string;
  readonly onQueryChange?: (value: string) => void;
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string | null) => void;
  readonly preview?: ArtifactDetail | null;
  readonly previewLoading?: boolean;
  readonly previewError?: string | null;
  /** Needed to build the HTML preview route's URL; the "Open in
   * new tab" / iframe affordance is simply absent without one (a
   * standalone render with no bench tenant, e.g. these page tests). */
  readonly tenantId?: string | null;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeQuery = query ?? localQuery;
  const setActiveQuery = onQueryChange ?? setLocalQuery;
  const activeSelected = onSelect !== undefined ? selectedId : localSelected;
  const select = onSelect ?? setLocalSelected;

  const visible = useMemo(
    () =>
      sortArtifacts(
        onQueryChange === undefined ? filterArtifacts(artifacts, activeQuery) : artifacts,
        "newest",
      ),
    [artifacts, activeQuery, onQueryChange],
  );

  const visibleIds = useMemo(() => visible.map((artifact) => artifact.id), [visible]);
  // Deliberate: matches Finder/Sheets — clearing a filter doesn't lose
  // your picks, since `useListSelection` keeps them in internal state.
  const selection = useListSelection({ ids: visibleIds });

  const openPicker = useCallback(() => {
    if (uploading === true) return;
    fileInputRef.current?.click();
  }, [uploading]);

  useEffect(() => {
    if (onUpload === undefined) return;
    // Off-route Upload navigates first and leaves a pending flag; open now.
    if (consumePendingLibraryUpload()) openPicker();
    window.addEventListener(LIBRARY_UPLOAD_EVENT, openPicker);
    return () => window.removeEventListener(LIBRARY_UPLOAD_EVENT, openPicker);
  }, [onUpload, openPicker]);

  const selectedSummary =
    activeSelected === null
      ? null
      : (artifacts.find((artifact) => artifact.id === activeSelected) ?? null);

  return (
    <div className="page-frame">
      <StageTopBar
        title={selectedSummary === null ? "Artifacts" : selectedSummary.title}
        subtitle={
          selectedSummary === null
            ? // Empty Artifacts already has a poster invitation — a "0
              // artifacts" count beside it is a second empty announcement.
              artifacts.length === 0
              ? undefined
              : `${artifacts.length} artifacts`
            : artifactKindLabel(selectedSummary.kind)
        }
        actions={
          selectedSummary !== null ? (
            // An action, not a filter. Used to say bare "All", which read
            // as a third scope option next to "All workbenches".
            <Button variant="ghost" size="sm" onClick={() => select(null)}>
              Back to artifacts
            </Button>
          ) : undefined
        }
      />
      {onUpload !== undefined ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const list = event.target.files;
            if (list !== null && list.length > 0) {
              onUpload(Array.from(list));
            }
            event.target.value = "";
          }}
        />
      ) : null}
      {uploadError !== undefined && uploadError !== null ? (
        <p className="page-error lib-error" role="alert">
          {uploadError}
        </p>
      ) : null}
      <div className="lib-split">
        <div className="lib-list-pane">
          <PageLayout title="Artifacts" subtitle="Everything your workers made. Yours to keep.">
            <ListFilter label="Filter artifacts" value={activeQuery} onChange={setActiveQuery} />
            {artifacts.length === 0 ? (
              <RichEmptyState
                icon={<Stack />}
                title="No artifacts yet"
                description="Upload a file, or let your agents drop their work here — it lands the moment it exists."
              />
            ) : visible.length === 0 ? (
              <RichEmptyState
                icon={<Stack />}
                title="Nothing matches"
                description={`No file matches "${activeQuery}".`}
              />
            ) : (
              <div>
                <ArtifactRows
                  artifacts={visible}
                  now={now}
                  selectedId={activeSelected}
                  onSelect={(id) => select(id)}
                  selection={selection}
                />
              </div>
            )}
          </PageLayout>
        </div>
        {activeSelected !== null ? (
          <div className="lib-preview-pane">
            <PreviewPane
              tenantId={tenantId}
              detail={preview}
              loading={previewLoading}
              error={previewError}
              onClose={() => select(null)}
            />
          </div>
        ) : null}
      </div>
      <BulkActionBar count={selection.selectedCount} onClear={selection.clear}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-bulk-action={LIBRARY_BULK_OPERATION_IDS[0]}
          onClick={() => {
            const ids = [...selection.selectedIds].sort(
              (a, b) => visibleIds.indexOf(a) - visibleIds.indexOf(b),
            );
            void copyArtifactLinks(ids).then(
              () => toast(copyArtifactLinksToastLabel(ids.length)),
              () => toast("Couldn't copy the link"),
            );
          }}
        >
          <LinkIcon aria-hidden="true" />
          {copyArtifactLinksActionLabel(selection.selectedCount)}
        </Button>
      </BulkActionBar>
    </div>
  );
}

export function LibraryRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Only sets the initial selection; the user's own clicks stay local
  // state, as kind-nav selection already worked before this route existed.
  const deepLinkedArtifactId = libraryArtifactIdFromPath(path);
  const [selectedId, setSelectedId] = useState<string | null>(deepLinkedArtifactId);
  const [appliedDeepLink, setAppliedDeepLink] = useState(deepLinkedArtifactId);
  if (appliedDeepLink !== deepLinkedArtifactId) {
    setAppliedDeepLink(deepLinkedArtifactId);
    if (deepLinkedArtifactId !== null) setSelectedId(deepLinkedArtifactId);
  }
  const kindSegment = deepLinkedArtifactId === null ? libraryKindSegmentFromPath(path) : "";

  // The workbench the person just came from, if `last-workbench.ts`
  // recorded one — resolved via the same activity listing other
  // bench-scoped surfaces already fetch.
  const activity = useBenchActivity(selectedTenantId);
  const fromBench = useFromBench();
  const lastWorkbenchId =
    fromBench ?? (selectedTenantId === null ? null : readLastWorkbenchId(selectedTenantId));
  const workbenchScope =
    activity.kind === "ready"
      ? resolveLibraryWorkbenchScope(activity.workbenches, lastWorkbenchId)
      : null;
  const scopeTenantId = workbenchScope !== null ? workbenchScope.tenantId : selectedTenantId;

  const listPath =
    scopeTenantId === null
      ? ""
      : `/api/tenants/${scopeTenantId}/artifacts${
          searchQuery.trim() === "" ? "" : `?q=${encodeURIComponent(searchQuery.trim())}`
        }`;
  const page = useAPIQuery(listPath, ArtifactListPageSchema);

  const detailPath =
    scopeTenantId === null || selectedId === null
      ? ""
      : `/api/tenants/${scopeTenantId}/artifacts/${encodeURIComponent(selectedId)}`;
  const detail = useAPIQuery(detailPath, ArtifactDetailSchema);

  // A selection the filtered list no longer contains is dropped during
  // render, so the detail pane never paints for a row that is not there.
  if (selectedId !== null && page.kind === "ready") {
    const stillThere = mapArtifactListToSummaries(page.data.artifacts)
      .filter((row) => artifactMatchesLibraryKindSegment(row, kindSegment))
      .some((row) => row.id === selectedId);
    if (!stillThere) setSelectedId(null);
  }

  if (selectedTenantId === null) {
    return (
      <div className="page-frame">
        <StageTopBar title="Artifacts" />
        <PageLayout title="Artifacts" subtitle="Everything your workers made. Yours to keep.">
          <RichEmptyState
            icon={<Stack />}
            title="Select a workbench"
            description="Open a workbench to browse the artifacts it owns."
          />
        </PageLayout>
      </div>
    );
  }

  if (page.kind === "error" && isArtifactsUnavailableStatus(page.status)) {
    return (
      <div className="page-frame">
        <StageTopBar title="Artifacts" />
        <PageLayout title="Artifacts" subtitle="Everything your workers made. Yours to keep.">
          <RichEmptyState
            icon={<Stack />}
            title="Artifacts not configured"
            description="Artifacts isn't set up yet. Ask your workbench admin to finish setup."
          />
        </PageLayout>
      </div>
    );
  }

  if (page.kind !== "ready") {
    return (
      <div className="page-frame">
        <StageTopBar title="Artifacts" />
        <PageLayout title="Artifacts" subtitle="Everything your workers made. Yours to keep.">
          {page.kind === "loading" ? (
            <ListSkeleton />
          ) : page.kind === "unauthenticated" ? (
            <SignedOutNotice />
          ) : (
            <RichEmptyState
              icon={<Stack />}
              title="Couldn't load your artifacts"
              description={describeApiError({ status: page.status }, "loading your artifacts")}
            />
          )}
        </PageLayout>
      </div>
    );
  }

  return (
    <QueryView query={page} label="your artifacts" skeleton="rows">
      {(rows) => {
        const artifacts = mapArtifactListToSummaries(rows.artifacts).filter((row) =>
          artifactMatchesLibraryKindSegment(row, kindSegment),
        );
        return (
          <LibraryPage
            artifacts={artifacts}
            tenantId={scopeTenantId}
            uploading={uploading}
            uploadError={uploadError}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            selectedId={selectedId}
            onSelect={setSelectedId}
            preview={detail.kind === "ready" ? detail.data.artifact : null}
            previewLoading={detail.kind === "loading" && selectedId !== null}
            previewError={
              detail.kind === "error" && selectedId !== null
                ? describeApiError({ status: detail.status }, "loading this file")
                : null
            }
            onUpload={(files) => {
              void (async () => {
                setUploading(true);
                setUploadError(null);
                try {
                  const uploaded = await uploadArtifactFiles(selectedTenantId, files);
                  await queryClient.invalidateQueries({
                    queryKey: tenantKeys.artifacts(selectedTenantId),
                  });
                  // Names what the server actually stored, never the local
                  // `File` picked — the two can differ (e.g. a collision
                  // rename).
                  toast(artifactUploadToast(uploaded.map((artifact) => artifact.title)));
                } catch (err) {
                  setUploadError(describeApiError(err, "uploading those files"));
                } finally {
                  setUploading(false);
                }
              })();
            }}
          />
        );
      }}
    </QueryView>
  );
}
