// Col2 "Routines" band: search + mode filter chips (All / Scheduled /
// Triggers / On demand) over the bench's routine list. Split out of
// panel-contributions.tsx — that registry file is a hotspot many pages
// touch, so each page-specific band gets its own module.
//
// The chip-to-trigger matching itself (`routineMatchesModeFilter`) lives in
// `@corbits/routines/trigger` — a product rule about what "Scheduled" means
// belongs with the routines domain, not this app. That subpath (not the
// package's default export) is deliberate: the default export pulls in
// `drizzle-orm` and `postgres` through `store.ts`, which have no business in
// a browser bundle.
import {
  EmptyState,
  FilterChip,
  Input,
  SidebarItemRow,
  Skeleton,
} from "@corbits/react-ui";
import { routineMatchesModeFilter } from "@corbits/routines/trigger";
import type { RoutineModeFilter } from "@corbits/routines/trigger";
import { Workflow } from "lucide-react";
import { useState } from "react";

import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";
import { listRoutines, useTenantQuery, type Routine } from "../routines-api";

const MODE_FILTERS: readonly { id: RoutineModeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "schedule", label: "Scheduled" },
  { id: "trigger", label: "Triggers" },
  { id: "demand", label: "On demand" },
];

function routineIdFromPath(path: string): string | null {
  if (!path.startsWith("/routines/")) return null;
  const rest = path.slice("/routines/".length);
  return rest === "" ? null : decodeURIComponent(rest);
}

function routinePath(id: string): string {
  return `/routines/${encodeURIComponent(id)}`;
}

/**
 * What the panel should navigate to after a filter change: the currently
 * open routine when it still matches, otherwise the first routine that
 * does, otherwise the bare list — mirrors the shell mock's `rtf-*` chip
 * handler (re-pick the selection, never leave a stale one showing).
 */
export function nextRoutinePathForFilter(
  routines: readonly Routine[],
  filter: RoutineModeFilter,
  currentSelectedId: string | null,
): string {
  const matches = (routine: Routine) =>
    routineMatchesModeFilter(routine.trigger, filter);
  const current =
    currentSelectedId !== null
      ? routines.find((r) => r.id === currentSelectedId)
      : undefined;
  if (current !== undefined && matches(current)) {
    return routinePath(current.id);
  }
  const next = routines.find(matches);
  return next !== undefined ? routinePath(next.id) : "/routines";
}

export function RoutinesFeedBand({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<RoutineModeFilter>("all");
  const selectedId = routineIdFromPath(path);
  const routines = useTenantQuery(
    selectedTenantId === null
      ? (["tenant", "none", "routines"] as const)
      : tenantKeys.routines(selectedTenantId),
    selectedTenantId !== null,
    () => listRoutines(selectedTenantId ?? ""),
  );

  if (selectedTenantId === null) {
    return (
      <EmptyState
        icon={<Workflow />}
        title="No bench selected"
        description="Choose a bench from the rail to see routines."
      />
    );
  }
  if (routines.kind === "loading") {
    return <Skeleton className="shell-activity-skeleton" />;
  }
  if (routines.kind === "error") {
    return (
      <EmptyState
        icon={<Workflow />}
        title="Couldn't load routines"
        description={routines.message}
      />
    );
  }
  if (routines.kind === "unauthenticated") {
    return (
      <EmptyState
        icon={<Workflow />}
        title="Sign in required"
        description="Sign in to see routines for this bench."
      />
    );
  }

  const routinesList = routines.data;

  function selectMode(next: RoutineModeFilter) {
    setModeFilter(next);
    onNavigate(nextRoutinePathForFilter(routinesList, next, selectedId));
  }

  const q = query.trim().toLowerCase();
  const items: readonly Routine[] = routinesList
    .filter((r) => routineMatchesModeFilter(r.trigger, modeFilter))
    .filter((r) => q === "" || r.name.toLowerCase().includes(q));

  return (
    <div className="panel-stack" aria-label="Routines">
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search routines"
        aria-label="Search routines"
      />
      <div className="panel-filter-row" role="group" aria-label="Filter by mode">
        {MODE_FILTERS.map((filter) => (
          <FilterChip
            key={filter.id}
            selected={modeFilter === filter.id}
            onClick={() => selectMode(filter.id)}
          >
            {filter.label}
          </FilterChip>
        ))}
      </div>
      {routinesList.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="No routines yet"
          description="Create a routine to run a workflow on a schedule."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="No matching routines"
          description={
            q === ""
              ? "No routines match this filter yet."
              : `Nothing matches “${query.trim()}”.`
          }
        />
      ) : (
        items.map((routine) => (
          <SidebarItemRow
            key={routine.id}
            name={routine.name}
            meta={routine.enabled ? "On" : "Off"}
            selected={selectedId === routine.id}
            onSelect={() => onNavigate(routinePath(routine.id))}
          />
        ))
      )}
    </div>
  );
}
