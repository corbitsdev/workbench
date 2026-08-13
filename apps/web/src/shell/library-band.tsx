// The Library page-specific panel band: the kind nav (All/Docs/Sheets/
// PDFs/Routines) with real per-kind counts from the hub's honest counts
// route (`GET /api/tenants/:id/artifacts/counts`, in `apps/hub`, which
// walks the tenant's full artifact list and buckets it with the same
// `@corbits/artifact-ui` predicate the Library page filters by — the nav
// and the page can never disagree on what counts as a "sheet"). Extracted
// out of `panel-contributions.tsx` so that shared registry file stays a
// thin list of contributions rather than growing every page's band inline.
//
// Counts are honest: while they're loading or the route errors, rows
// render without a number rather than showing a stale or invented one.

import { SidebarItemRow } from "@corbits/react-ui";

import { ArtifactCountsSchema, useAPIQuery, type ArtifactCounts } from "../api";
import { useBench } from "../bench-context";
import { artifactCountsPath } from "./library-artifacts";

const LIBRARY_KIND_ROWS: readonly {
  readonly id: keyof ArtifactCounts;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "document", label: "Docs" },
  { id: "sheet", label: "Sheets" },
  { id: "pdf", label: "PDFs" },
  { id: "routine", label: "Routines" },
];

function libraryPathForKind(id: keyof ArtifactCounts): string {
  return id === "all" ? "/library" : `/library/${id}`;
}

export function LibraryKindBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const counts = useAPIQuery(
    selectedTenantId === null ? "" : artifactCountsPath(selectedTenantId),
    ArtifactCountsSchema,
  );

  return (
    <div className="panel-stack" aria-label="Library kinds">
      {LIBRARY_KIND_ROWS.map((row) => (
        <SidebarItemRow
          key={row.id}
          name={row.label}
          meta={
            counts.kind === "ready" ? String(counts.data[row.id]) : undefined
          }
          selected={path === libraryPathForKind(row.id)}
          onSelect={() => onNavigate(libraryPathForKind(row.id))}
        />
      ))}
    </div>
  );
}
