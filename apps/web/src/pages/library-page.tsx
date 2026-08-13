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
} from "@corbits/react-ui";
import type { ViewMode } from "@corbits/react-ui";
import {
  ArtifactCard,
  filterArtifacts,
  sortArtifacts,
} from "@corbits/artifact-ui";
import type { ArtifactSort, ArtifactSummary } from "@corbits/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, FileStack, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
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
import { tenantKeys } from "../query-client";
import { QueryView } from "../query-view";
import {
  isArtifactsUnavailableMessage,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
} from "../shell/library-artifacts";
import {
  artifactMatchesLibraryKindSegment,
  libraryKindSegmentFromPath,
} from "../shell/library-filters";
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

function PreviewPane({
  detail,
  loading,
  error,
  onClose,
}: {
  readonly detail: ArtifactDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
}) {
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
        </div>
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
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? <Skeleton className="h-40 w-full" /> : null}
        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {!loading && error === null && detail !== null ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
            {detail.content === "" ? "(empty content)" : detail.content}
          </pre>
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

  const openPicker = () => {
    if (uploading === true) return;
    fileInputRef.current?.click();
  };

  useEffect(() => {
    if (onUpload === undefined) return;
    const openFromEvent = () => {
      if (uploading === true) return;
      fileInputRef.current?.click();
    };
    // Off-route Upload navigates first and leaves a pending flag; open now.
    if (consumePendingLibraryUpload()) openFromEvent();
    window.addEventListener(LIBRARY_UPLOAD_EVENT, openFromEvent);
    return () =>
      window.removeEventListener(LIBRARY_UPLOAD_EVENT, openFromEvent);
  }, [onUpload, uploading]);

  const selectedSummary =
    activeSelected === null
      ? null
      : (artifacts.find((artifact) => artifact.id === activeSelected) ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={selectedSummary === null ? "Library" : selectedSummary.title}
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const kindSegment = libraryKindSegmentFromPath(path);

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
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<FileStack />}
          title="Select a workbench"
          description="Pick a workbench from the switcher to browse the artifacts it owns."
        />
      </PageShell>
    );
  }

  if (page.kind === "error" && isArtifactsUnavailableMessage(page.message)) {
    return (
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<FileStack />}
          title="Library not configured"
          description="This hub has no artifacts plane mounted yet. Set ARTIFACTS_DATABASE_URL and restart the hub to enable Library."
        />
      </PageShell>
    );
  }

  return (
    <QueryView query={page} label="library artifacts">
      {(rows) => {
        const artifacts = mapArtifactListToSummaries(rows.data).filter((row) =>
          artifactMatchesLibraryKindSegment(row, kindSegment),
        );
        return (
          <LibraryPage
            artifacts={artifacts}
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
                ? detail.message
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
                } catch (err) {
                  setUploadError(
                    err instanceof Error ? err.message : String(err),
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
