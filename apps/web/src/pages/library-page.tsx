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
  TopBar,
  TopBarActions,
  TopBarTitle,
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

import { countProp } from "../optional-props";

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
 * mode — but the hub does not yet expose a cross-tenant artifact store (see
 * `LibraryRoute` below), so `artifacts` is honestly empty until that
 * endpoint exists. Nothing here is placeholder content: an empty `artifacts`
 * array renders the teaching empty state, never fabricated rows.
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
      <TopBar>
        <TopBarTitle
          {...countProp(visible.length)}
          subtitle="Documents, exports, and other artifacts your workflows produce"
        >
          Library
        </TopBarTitle>
        <TopBarActions>
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
        </TopBarActions>
      </TopBar>
      <PageShell width="full" className="page-fill">
        {artifacts.length === 0 ? (
          <RichEmptyState
            icon={<FileStack />}
            title="No artifacts yet"
            description="The hub doesn't expose an artifact store across benches yet. Once a workflow run can publish an output — a document, an export, a deck — it appears here: searchable, sortable, and grouped by kind."
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
  // Seam, not a stub: `ArtifactSummary` (packages/artifact-ui) is the shape
  // a future cross-tenant `/api/.../artifacts` endpoint will fill. Until the
  // hub exposes one, this stays a real, empty list rather than a fetch
  // against a route that doesn't exist — the presentation above is fully
  // wired against it and needs no changes once the endpoint lands.
  const artifacts: readonly ArtifactSummary[] = [];
  return <LibraryPage artifacts={artifacts} />;
}
