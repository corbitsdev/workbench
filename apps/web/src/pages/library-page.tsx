import {
  BulkActionBar,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageShell,
  RichEmptyState,
  SelectionCheckbox,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ViewToggle,
  artifactKindLabel,
  formatRelativeTime,
  toast,
  useListSelection,
} from "@corbits/react-ui";
import type { SelectionCheckboxState, UseListSelectionResult, ViewMode } from "@corbits/react-ui";
import {
  ArtifactCard,
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
import type { ArtifactSort, ArtifactSummary } from "@/library";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowsDownUp, ArrowSquareOut, LinkSimple as LinkIcon, Stack, X } from "@/lib/icons";
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
import { readLastWorkbenchId } from "../last-workbench";
import { consumePendingLibraryUpload, LIBRARY_UPLOAD_EVENT } from "../library-upload";
import { resolveLibraryWorkbenchScope } from "../library-workbench-scope";
import { Link } from "../navigation";
import { ARTIFACTS_PATH_PREFIX } from "../path-ids";
import { tenantKeys } from "../query-client";
import { useBenchActivity } from "../shell/bench-activity";
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
import { StageTopBar } from "../shell/stage-top-bar";

const SORT_LABEL: Record<ArtifactSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

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
  const allSelected = artifacts.length > 0 && selection.selectedCount === artifacts.length;
  const headerChecked: SelectionCheckboxState =
    selection.selectedCount === 0 ? false : allSelected ? true : "indeterminate";
  // `useListSelection` hands back ids in toggle order, not row order — a
  // bottom-up shift-select would otherwise copy links out of visible order.
  const visibleOrder = useMemo(
    () => new Map(artifacts.map((artifact, index) => [artifact.id, index])),
    [artifacts],
  );

  return (
    <Table aria-label="Artifacts">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <SelectionCheckbox
              checked={headerChecked}
              onToggle={() => (allSelected ? selection.clear() : selection.selectAll())}
              rowLabel="all artifacts"
              ariaLabel="Select all artifacts"
              className="opacity-100"
            />
          </TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {artifacts.map((artifact) => {
          const isSelected = selection.isSelected(artifact.id);
          const selectionIds =
            isSelected && selection.selectedCount > 1
              ? [...selection.selectedIds].sort(
                  (a, b) => (visibleOrder.get(a) ?? 0) - (visibleOrder.get(b) ?? 0),
                )
              : [artifact.id];
          return (
            <TableRow
              key={artifact.id}
              data-state={selectedId === artifact.id ? "selected" : undefined}
              data-ctx-artifact={artifact.id}
              data-ctx-artifact-selected-ids={selectionIds.join(",")}
              className="group cursor-pointer"
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
              <TableCell onClick={(event) => event.stopPropagation()}>
                <SelectionCheckbox
                  checked={isSelected}
                  onToggle={(modifiers) => selection.toggle(artifact.id, modifiers)}
                  rowLabel={artifact.title}
                />
              </TableCell>
              <TableCell className="font-medium">{artifact.title}</TableCell>
              <TableCell className="text-muted-foreground">
                {artifactKindLabel(artifact.kind)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(artifact.updatedAt ?? artifact.createdAt, now)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// Not a lineage system — every other origin renders nothing rather than
// guessing.
function ProvenanceLine({ source }: { readonly source: Record<string, unknown> }) {
  const runId = workflowRunIdFromSource(source);
  if (runId === null) return null;
  return (
    <p className="mt-0.5 truncate text-xs">
      <Link
        to={`/insights/runs/${encodeURIComponent(runId)}`}
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
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
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{detail?.title ?? "Preview"}</p>
          {detail !== null ? (
            <p className="truncate text-xs text-muted-foreground">
              {artifactKindLabel(detail.kind)}
              {` · Version ${detail.version}`}
            </p>
          ) : null}
          {detail !== null ? <ProvenanceLine source={detail.source} /> : null}
        </div>
        <div className="flex items-center gap-1">
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
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? <Skeleton className="h-40 w-full" /> : null}
        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
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

// Every control lives in `StageTopBar`'s action slot (DESIGN.md -> Pages
// & Routing) — a page body never floats its own.
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
  workbenchScope = null,
  scope = "all",
  onScopeChange,
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
  /** The workbench the person just came from, if any — drives the
   * "This workbench" pill. `null` when Artifacts was reached with no workbench
   * in view, in which case the lens has nothing to offer and stays hidden. */
  readonly workbenchScope?: { readonly title: string } | null;
  /** Which lens is active: this one workbench's files, or every workbench
   * this bench owns. Uncontrolled callers (tests, standalone renders) get
   * "all" and no toggle, same as every other optional-controlled prop here. */
  readonly scope?: "workbench" | "all";
  readonly onScopeChange?: (scope: "workbench" | "all") => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [sort, setSort] = useState<ArtifactSort>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("rows");
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
        sort,
      ),
    [artifacts, activeQuery, sort, onQueryChange],
  );

  const visibleIds = useMemo(() => visible.map((artifact) => artifact.id), [visible]);
  // Deliberate: matches Finder/Sheets — clearing a filter doesn't lose
  // your picks, since `useListSelection` keeps them in internal state.
  const selection = useListSelection({ ids: visibleIds });

  // Only rows has checkboxes, so a selection has nothing to anchor to in
  // cards — clearing on view change is simpler than adding card checkboxes.
  const [selectionViewMode, setSelectionViewMode] = useState(viewMode);
  if (selectionViewMode !== viewMode) {
    setSelectionViewMode(viewMode);
    selection.clear();
  }

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
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={
          selectedSummary === null
            ? [{ label: "Artifacts" }]
            : [
                { label: "Artifacts", href: ARTIFACTS_PATH_PREFIX },
                { label: selectedSummary.title },
              ]
        }
        subtitle={
          selectedSummary === null
            ? // Empty Artifacts already has a poster invitation — a "0
              // artifacts" count beside it is a second empty announcement.
              artifacts.length === 0
              ? undefined
              : `${artifacts.length} artifacts`
            : artifactKindLabel(selectedSummary.kind)
        }
        filter={{
          label: "Filter artifacts",
          placeholder: "Filter by name",
          value: activeQuery,
          onChange: setActiveQuery,
        }}
        actions={
          <>
            {selectedSummary !== null ? (
              // An action, not a filter. Used to say bare "All", which read
              // as a third scope option next to "All workbenches".
              <Button variant="ghost" size="sm" onClick={() => select(null)}>
                Back to artifacts
              </Button>
            ) : null}
            {workbenchScope !== null && onScopeChange !== undefined ? (
              // Below lg the segmented group is hidden; the overflow menu
              // in this same slot is the way to reach All workbenches.
              <>
                <div
                  role="group"
                  aria-label="Artifacts scope"
                  className="hidden items-center gap-0.5 rounded-md border border-border p-0.5 lg:flex"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={scope === "workbench" ? "outline" : "ghost"}
                    aria-pressed={scope === "workbench"}
                    onClick={() => onScopeChange("workbench")}
                  >
                    {workbenchScope.title}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={scope === "all" ? "outline" : "ghost"}
                    aria-pressed={scope === "all"}
                    onClick={() => onScopeChange("all")}
                  >
                    All workbenches
                  </Button>
                </div>
                <div className="lg:hidden">
                  <Menu>
                    <MenuTrigger asChild>
                      <Button type="button" size="sm" variant="ghost" aria-label="Artifacts scope">
                        {scope === "all" ? "All workbenches" : workbenchScope.title}
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem onSelect={() => onScopeChange("workbench")}>
                        {workbenchScope.title}
                      </MenuItem>
                      <MenuItem onSelect={() => onScopeChange("all")}>All workbenches</MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </>
            ) : null}
            <Menu>
              <MenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={SORT_LABEL[sort]}
                  title={SORT_LABEL[sort]}
                >
                  <ArrowsDownUp />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                {(Object.keys(SORT_LABEL) as ArtifactSort[]).map((option) => (
                  <MenuItem key={option} onSelect={() => setSort(option)}>
                    {SORT_LABEL[option]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            {onUpload !== undefined ? (
              <Button size="sm" disabled={uploading === true} onClick={openPicker}>
                {uploading === true ? "Uploading…" : "Upload"}
              </Button>
            ) : null}
          </>
        }
      />
      {onUpload !== undefined ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
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
        <p className="px-4 pt-2 text-sm text-destructive sm:px-7" role="alert">
          {uploadError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <PageShell width="full" className="page-fill">
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
            ) : viewMode === "rows" ? (
              <div className="px-4 pb-5 sm:px-7">
                <ArtifactRows
                  artifacts={visible}
                  now={now}
                  selectedId={activeSelected}
                  onSelect={(id) => select(id)}
                  selection={selection}
                />
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 px-4 pb-5 sm:px-7">
                {visible.map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    selected={activeSelected === artifact.id}
                    now={now}
                    onSelect={() => select(artifact.id)}
                    meta={{
                      snippet: null,
                    }}
                  />
                ))}
              </div>
            )}
          </PageShell>
        </div>
        {activeSelected !== null ? (
          <div className="hidden w-[min(28rem,40%)] shrink-0 md:flex md:flex-col">
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
  const lastWorkbenchId = selectedTenantId === null ? null : readLastWorkbenchId(selectedTenantId);
  const workbenchScope =
    activity.kind === "ready"
      ? resolveLibraryWorkbenchScope(activity.workbenches, lastWorkbenchId)
      : null;
  const [scopeOverride, setScopeOverride] = useState<"workbench" | "all" | null>(null);
  const scope = scopeOverride ?? (workbenchScope !== null ? "workbench" : "all");
  const scopeTenantId =
    scope === "workbench" && workbenchScope !== null ? workbenchScope.tenantId : selectedTenantId;

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
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Artifacts" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Stack />}
            title="Select a workbench"
            description="Open a workbench to browse the artifacts it owns."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind === "error" && isArtifactsUnavailableStatus(page.status)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Artifacts" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Stack />}
            title="Artifacts not configured"
            description="Artifacts isn't set up yet. Ask your workbench admin to finish setup."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Artifacts" }]} />
        <PageShell width="full" className="page-fill">
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
        </PageShell>
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
            workbenchScope={workbenchScope}
            scope={scope}
            onScopeChange={setScopeOverride}
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
