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
import { ArrowDownUp, FileStack } from "lucide-react";
import { useMemo, useState } from "react";

import { AssetsSchema, useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { mapAssetsToArtifacts } from "../shell/library-artifacts";
import { QueryView } from "../query-view";

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
 * mode. The route resolves the current bench's assets into the
 * `ArtifactSummary` rows this page renders (see `LibraryRoute`); an empty
 * list is a truthful empty bench, never fabricated rows.
 */
export function LibraryPage({
  artifacts,
  now,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  /** Reference time for relative timestamps; injectable for tests. */
  readonly now?: number;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ArtifactSort>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  const visible = useMemo(
    () => sortArtifacts(filterArtifacts(artifacts, query), sort),
    [artifacts, query, sort],
  );

  return (
    <>
      <div className="page-toolbar">
        <LibrarySearchInput
          label="Search artifacts"
          value={query}
          onChange={setQuery}
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
      </div>
      <PageShell width="full" className="page-fill">
        {artifacts.length === 0 ? (
          <RichEmptyState
            icon={<FileStack />}
            title="No artifacts yet"
            description="This workbench has no assets yet — workflows, skills, package registries, and agent state show up here as soon as they exist."
          />
        ) : visible.length === 0 ? (
          <RichEmptyState
            icon={<FileStack />}
            title="Nothing matches"
            description={`No artifact matches "${query}".`}
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
  // Tenant-local assets are the honest Library source today: the hub has no
  // separate artifact store, but every bench already owns workflows, skills,
  // package registries, and agent state at GET /api/tenants/:id/assets.
  const assets = useAPIQuery(
    selectedTenantId === null ? "" : `/api/tenants/${selectedTenantId}/assets`,
    AssetsSchema,
  );

  if (selectedTenantId === null) {
    return (
      <PageShell width="full" className="page-fill">
        <RichEmptyState
          icon={<FileStack />}
          title="Select a workbench"
          description="Pick a workbench from the switcher to browse the assets it owns."
        />
      </PageShell>
    );
  }

  return (
    <QueryView query={assets} label="library artifacts">
      {(rows) => <LibraryPage artifacts={mapAssetsToArtifacts(rows)} />}
    </QueryView>
  );
}
