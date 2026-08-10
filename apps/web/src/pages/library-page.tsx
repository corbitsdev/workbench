import {
  Button,
  LibrarySearchInput,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageShell,
  RichEmptyState,
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
  artifactKindColor,
  filterArtifacts,
  sortArtifacts,
} from "@corbits/artifact-ui";
import type { ArtifactSort, ArtifactSummary } from "@corbits/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownUp, FileStack, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { ArtifactListPageSchema, useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";

import { QueryView } from "../query-view";
import {
  isArtifactsUnavailableMessage,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
} from "../shell/library-artifacts";

const SORT_LABEL: Record<ArtifactSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

/**
 * One tile in the grid view: a kind-colored band over a title and kind
 * label, so a mixed gallery reads as distinct groups at a glance — the same
 * idea as the reference gallery's per-kind card fill.
 */
function ArtifactTile({ artifact }: { readonly artifact: ArtifactSummary }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card text-left">
      <span
        aria-hidden
        className={`block h-20 w-full ${artifactKindColor(artifact.kind)}`}
      />
      <span className="flex min-w-0 flex-col gap-0.5 p-3">
        <span className="truncate text-sm font-semibold">{artifact.title}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {artifactKindLabel(artifact.kind)}
        </span>
      </span>
    </div>
  );
}

function ArtifactRows({
  artifacts,
  now,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now: number | undefined;
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
          <TableRow key={artifact.id}>
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
 * The artifact gallery. Real data all the way down — search, sort, view
 * mode, and upload. The route resolves the current bench's artifacts into
 * the `ArtifactSummary` rows this page renders (see `LibraryRoute`); an empty
 * list is a truthful empty library, never fabricated rows.
 */
export function LibraryPage({
  artifacts,
  now,
  onUpload,
  uploading,
  uploadError,
  query,
  onQueryChange,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  /** Reference time for relative timestamps; injectable for tests. */
  readonly now?: number;
  readonly onUpload?: (files: readonly File[]) => void;
  readonly uploading?: boolean;
  readonly uploadError?: string | null;
  /** Controlled search string — when provided, the route owns server-side `q`. */
  readonly query?: string;
  readonly onQueryChange?: (value: string) => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [sort, setSort] = useState<ArtifactSort>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeQuery = query ?? localQuery;
  const setActiveQuery = onQueryChange ?? setLocalQuery;

  // When the route owns server-side search, filter is a no-op pass-through
  // (rows already match). Local-only consumers still filter client-side.
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

  return (
    <>
      <div className="page-toolbar">
        <LibrarySearchInput
          label="Search artifacts"
          value={activeQuery}
          onChange={setActiveQuery}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <ArrowDownUp /> {SORT_LABEL[sort]}
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
          <>
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
            <Button
              type="button"
              size="sm"
              disabled={uploading === true}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload /> {uploading === true ? "Uploading…" : "Upload"}
            </Button>
          </>
        ) : null}
      </div>
      {uploadError !== undefined && uploadError !== null ? (
        <p className="px-4 pt-2 text-sm text-destructive sm:px-7" role="alert">
          {uploadError}
        </p>
      ) : null}
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
            <ArtifactRows artifacts={visible} now={now} />
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3 px-4 pb-5 sm:px-7">
            {visible.map((artifact) => (
              <ArtifactTile key={artifact.id} artifact={artifact} />
            ))}
          </div>
        )}
      </PageShell>
    </>
  );
}

export function LibraryRoute() {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Real artifacts plane — list is paginated; `q` is server-side text search.
  const listPath =
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/artifacts${
          searchQuery.trim() === ""
            ? ""
            : `?q=${encodeURIComponent(searchQuery.trim())}`
        }`;
  const page = useAPIQuery(listPath, ArtifactListPageSchema);

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
      {(rows) => (
        <LibraryPage
          artifacts={mapArtifactListToSummaries(rows.data)}
          uploading={uploading}
          uploadError={uploadError}
          query={searchQuery}
          onQueryChange={setSearchQuery}
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
      )}
    </QueryView>
  );
}
