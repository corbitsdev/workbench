import {
  Button,
  LibrarySearchInput,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageShell,
  RichEmptyState,
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
} from "@corbits/react-ui";
import type { ViewMode } from "@corbits/react-ui";
import {
  ArtifactCard,
  ArtifactRenderer,
  artifactMatchesLibraryKindSegment,
  filterArtifacts,
  libraryArtifactIdFromPath,
  libraryKindSegmentFromPath,
  resolveArtifactRendererKind,
  sortArtifacts,
  workflowRunIdFromSource,
} from "@corbits/artifact-ui";
import type { ArtifactSort, ArtifactSummary } from "@corbits/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, ExternalLink, FileStack, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  describeApiError,
  ListSkeleton,
  QueryView,
  SignedOutNotice,
} from "@corbits/api-query";

import {
  artifactPreviewPath,
  ArtifactDetailSchema,
  ArtifactListPageSchema,
  useAPIQuery,
  type ArtifactDetail,
} from "../api";
import { useBench } from "../bench-context";
import {
  consumePendingLibraryUpload,
  LIBRARY_UPLOAD_EVENT,
} from "../library-upload";
import { Link } from "../navigation";
import { tenantKeys } from "../query-client";
import {
  artifactUploadToast,
  isArtifactsUnavailableStatus,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
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
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now: number | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Table aria-label="Artifacts">
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {artifacts.map((artifact) => (
          <TableRow
            key={artifact.id}
            data-state={selectedId === artifact.id ? "selected" : undefined}
            className="cursor-pointer"
            onClick={() => onSelect(artifact.id)}
          >
            <TableCell className="font-medium">{artifact.title}</TableCell>
            <TableCell className="text-muted-foreground">
              {artifactKindLabel(artifact.kind)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {artifact.ownerName ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(
                artifact.updatedAt ?? artifact.createdAt,
                now,
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The one cheap provenance fact worth surfacing (CL-6015): a link to the
 * workflow run that produced this artifact, when `source` says so
 * (`workflowRunIdFromSource`). Not a lineage system — every other origin
 * (manual, agent, imported, unknown) renders nothing here rather than
 * guessing.
 */
function ProvenanceLine({
  source,
}: {
  readonly source: Record<string, unknown>;
}) {
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
  const rendererKind =
    detail !== null ? resolveArtifactRendererKind(detail) : null;
  const previewSrc =
    detail !== null && rendererKind === "html" && tenantId !== null
      ? artifactPreviewPath(tenantId, detail.id)
      : undefined;
  return (
    <aside className="flex min-h-0 min-w-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {detail?.title ?? (loading ? "Loading…" : "Preview")}
          </p>
          {detail !== null ? (
            <p className="truncate text-xs text-muted-foreground">
              {artifactKindLabel(detail.kind)}
              {detail.ownerName !== null ? ` · ${detail.ownerName}` : ""}
              {` · v${detail.version}`}
            </p>
          ) : null}
          {detail !== null ? <ProvenanceLine source={detail.source} /> : null}
        </div>
        <div className="flex items-center gap-1">
          {previewSrc !== undefined ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={previewSrc} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden="true" />
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
        {!loading &&
        error === null &&
        detail !== null &&
        rendererKind !== null ? (
          <ArtifactRenderer
            rendererKind={rendererKind}
            title={detail.title}
            content={detail.content}
            {...(previewSrc !== undefined ? { previewSrc } : {})}
          />
        ) : null}
      </div>
    </aside>
  );
}

/**
 * Artifact gallery with dense cards (kind badge, title, owner · updated)
 * and an in-stage preview when a row is selected. Real data only.
 */
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
  /** Needed to build the HTML preview route's URL (CL-5879); the "Open in
   * new tab" / iframe affordance is simply absent without one (a
   * standalone render with no bench tenant, e.g. these page tests). */
  readonly tenantId?: string | null;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [sort, setSort] = useState<ArtifactSort>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeQuery = query ?? localQuery;
  const setActiveQuery = onQueryChange ?? setLocalQuery;
  const activeSelected = onSelect !== undefined ? selectedId : localSelected;
  const select = onSelect ?? setLocalSelected;

  const visible = useMemo(
    () =>
      sortArtifacts(
        onQueryChange === undefined
          ? filterArtifacts(artifacts, activeQuery)
          : artifacts,
        sort,
      ),
    [artifacts, activeQuery, sort, onQueryChange],
  );

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
        title={selectedSummary === null ? "Files" : selectedSummary.title}
        subtitle={
          selectedSummary === null
            ? `${artifacts.length} artifacts`
            : artifactKindLabel(selectedSummary.kind)
        }
        actions={
          <>
            {selectedSummary !== null ? (
              <Button variant="outline" size="sm" onClick={() => select(null)}>
                All
              </Button>
            ) : null}
            {onUpload !== undefined ? (
              <Button
                size="sm"
                disabled={uploading === true}
                onClick={openPicker}
              >
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
          aria-label="Upload artifacts"
          onChange={(event) => {
            const list = event.target.files;
            if (list !== null && list.length > 0) {
              onUpload(Array.from(list));
            }
            event.target.value = "";
          }}
        />
      ) : null}
      <div className="page-toolbar">
        <LibrarySearchInput
          label="Search artifacts"
          value={activeQuery}
          onChange={setActiveQuery}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={SORT_LABEL[sort]}
              title={SORT_LABEL[sort]}
            >
              <ArrowDownUp />
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
      </div>
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
                icon={<FileStack />}
                title="No artifacts yet"
                description="Upload a file or wait for agents and workflows to produce artifacts — they land here as soon as they exist."
              />
            ) : visible.length === 0 ? (
              <RichEmptyState
                icon={<FileStack />}
                title="Nothing matches"
                description={`No artifact matches "${activeQuery}".`}
              />
            ) : viewMode === "rows" ? (
              <div className="px-4 pb-5 sm:px-7">
                <ArtifactRows
                  artifacts={visible}
                  now={now}
                  selectedId={activeSelected}
                  onSelect={(id) => select(id)}
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
    </div>
  );
}

export function LibraryRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // `/files/a/:id` (CL-6015) — a chat artifact chip's "Open in Files"
  // deep link, distinct from the kind-nav segments below. It only ever
  // sets the initial selection; the user's own clicks stay local state,
  // the same way kind-nav selection already worked before this route
  // existed.
  const deepLinkedArtifactId = libraryArtifactIdFromPath(path);
  const [selectedId, setSelectedId] = useState<string | null>(
    deepLinkedArtifactId,
  );
  useEffect(() => {
    if (deepLinkedArtifactId !== null) setSelectedId(deepLinkedArtifactId);
  }, [deepLinkedArtifactId]);
  const kindSegment =
    deepLinkedArtifactId === null ? libraryKindSegmentFromPath(path) : "";

  const listPath =
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/artifacts${
          searchQuery.trim() === ""
            ? ""
            : `?q=${encodeURIComponent(searchQuery.trim())}`
        }`;
  const page = useAPIQuery(listPath, ArtifactListPageSchema);

  const detailPath =
    selectedTenantId === null || selectedId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/artifacts/${encodeURIComponent(selectedId)}`;
  const detail = useAPIQuery(detailPath, ArtifactDetailSchema);

  // Drop selection when the filtered list no longer contains the id.
  useEffect(() => {
    if (selectedId === null || page.kind !== "ready") return;
    const stillThere = mapArtifactListToSummaries(page.data.data)
      .filter((row) => artifactMatchesLibraryKindSegment(row, kindSegment))
      .some((row) => row.id === selectedId);
    if (!stillThere) setSelectedId(null);
  }, [page, selectedId, kindSegment]);

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Files" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<FileStack />}
            title="Select a workbench"
            description="Pick a workbench from the switcher to browse the artifacts it owns."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind === "error" && isArtifactsUnavailableStatus(page.status)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Files" />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<FileStack />}
            title="Files not configured"
            description="Files isn't set up yet. Ask your workbench admin to finish setup."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar title="Files" />
        <PageShell width="full" className="page-fill">
          {page.kind === "loading" ? (
            <ListSkeleton />
          ) : page.kind === "unauthenticated" ? (
            <SignedOutNotice />
          ) : (
            <RichEmptyState
              icon={<FileStack />}
              title="Couldn't load artifacts"
              description={describeApiError(
                { status: page.status },
                "loading your artifacts",
              )}
            />
          )}
        </PageShell>
      </div>
    );
  }

  return (
    <QueryView query={page} label="library artifacts" skeleton="rows">
      {(rows) => {
        const artifacts = mapArtifactListToSummaries(rows.data).filter((row) =>
          artifactMatchesLibraryKindSegment(row, kindSegment),
        );
        return (
          <LibraryPage
            artifacts={artifacts}
            tenantId={selectedTenantId}
            uploading={uploading}
            uploadError={uploadError}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            selectedId={selectedId}
            onSelect={setSelectedId}
            preview={detail.kind === "ready" ? detail.data : null}
            previewLoading={detail.kind === "loading" && selectedId !== null}
            previewError={
              detail.kind === "error" && selectedId !== null
                ? describeApiError(
                    { status: detail.status },
                    "loading this artifact",
                  )
                : null
            }
            onUpload={(files) => {
              void (async () => {
                setUploading(true);
                setUploadError(null);
                try {
                  await uploadArtifactFiles(selectedTenantId, files);
                  await queryClient.invalidateQueries({
                    queryKey: tenantKeys.artifacts(selectedTenantId),
                  });
                  toast(artifactUploadToast(files.map((file) => file.name)));
                } catch (err) {
                  setUploadError(
                    describeApiError(err, "uploading those files"),
                  );
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
