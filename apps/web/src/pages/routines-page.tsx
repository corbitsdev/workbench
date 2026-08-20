// Routines: one global list, every automation across every workbench the
// signed-in account is a member of (CL-6362). Per-workbench routines
// chrome (the header's Routines button, the `/run` composer command, and
// the canvas pane's list/runs views) is gone — this page is the only
// place to browse and run routines now; a routine's own workbench still
// shows it "where it was made" via in-room notices and run-now approval
// cards, which this page never touches.
//
// Visibility resolves through the same membership the sidebar's bench
// switcher uses (`useBench().memberships`, the `/api/me/principals` /
// CL-6332 principal model), filtered to actual benches with
// `classifyBenchMembership` — never just the currently selected one, and
// never creator-scoped: `GET /routines` already lists every routine a
// bench's own grant covers, regardless of who created it.
import {
  Badge,
  Button,
  EmptyState,
  formatRelativeTime,
  RichEmptyState,
  RunNowButton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { listWorkbenches } from "@corbits/chat-ui";
import {
  classifyBenchMembership,
  listWorkbenchTenantIds,
} from "@corbits/bench-ui";
import { CaretDown, CaretRight, Clock } from "@corbits/icons";
import { Fragment, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { APIQuery } from "@corbits/api-query";

import type { Principal } from "../api";
import { useBench } from "../bench-context";
import { workbenchPath } from "../workbench-path";
import { meKeys, tenantKeys } from "../query-client";
import { cadenceLabel, approximateNextRun } from "../routine-trigger";
import { useOpenRoutineInCanvas } from "../shell/canvas-availability";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  listRoutineRuns,
  listRoutines,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
} from "../routines-api";
import type { Routine, RoutineRun } from "../routines-api";

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  running: "success",
  completed: "info",
  failed: "danger",
  cancelled: "neutral",
};

/**
 * Recent-run rows deep-link to the workbench the routine delivers to — a
 * routine has one `deliveryWorkbenchId`, not a per-run one, so every row
 * in a given table shares the same destination. Rows render as plain data
 * when there is nowhere to deep-link (`deliveryWorkbenchId` absent or no
 * `onOpenWorkbench` handler wired). Exported: the canvas routine editor
 * panel (`shell/routine-panel.tsx`) reuses this exact rendering for its
 * own "Recent runs" section — one run table, never two drifting ones.
 */
export function RunsTable({
  runs,
  now,
  emptyTitle,
  emptyDescription,
  deliveryWorkbenchId = null,
  onOpenWorkbench,
}: {
  readonly runs: readonly RoutineRun[];
  readonly now: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly deliveryWorkbenchId?: string | null;
  readonly onOpenWorkbench?: (workbenchId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clock />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  const workbenchId =
    deliveryWorkbenchId !== null && onOpenWorkbench !== undefined
      ? deliveryWorkbenchId
      : null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Triggered by</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const status = run.run?.status;
          const rowProps =
            workbenchId !== null
              ? {
                  role: "link" as const,
                  tabIndex: 0,
                  className: "routine-run-row-linked",
                  onClick: () => onOpenWorkbench?.(workbenchId),
                  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpenWorkbench?.(workbenchId);
                  },
                }
              : {};
          const hasError = run.error !== undefined && run.error !== null;
          return (
            <TableRow key={run.runId} {...rowProps}>
              <TableCell>
                <Badge tone={hasError ? "danger" : "neutral"}>
                  {run.triggeredBy === "schedule-failed"
                    ? "Failed to start"
                    : run.triggeredBy}
                </Badge>
                {hasError ? (
                  <p className="mt-1 max-w-xs text-xs text-[var(--ui-fg-muted)]">
                    {run.error}
                  </p>
                ) : null}
              </TableCell>
              <TableCell>
                {typeof status === "string" ? (
                  <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"}>
                    {status}
                  </Badge>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>{formatRelativeTime(run.createdAt, now)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Every bench the signed-in account belongs to — not just the currently
 * selected one — the same classification the bench switcher uses so a
 * workbench child tenancy or a raw-id row never masquerades as a bench a
 * person can browse routines in. */
function useMemberBenches(): {
  readonly kind: "loading" | "ready";
  readonly benches: readonly { tenantId: string; tenantName: string }[];
} {
  const { memberships } = useBench();
  const allMemberships: readonly Principal[] =
    memberships.kind === "ready" ? memberships.data.data : [];
  const tenantIds = useMemo(
    () => allMemberships.map((m) => m.tenantId),
    [allMemberships],
  );
  const workbenchTenancyKinds = useQuery({
    queryKey: meKeys.workbenchTenancyKinds(tenantIds),
    queryFn: () => listWorkbenchTenantIds(tenantIds),
    enabled: tenantIds.length > 0,
  });
  const benches = useMemo(
    () =>
      allMemberships
        .filter(
          (m) =>
            classifyBenchMembership(
              m,
              workbenchTenancyKinds.data ?? new Set(),
            ) === "bench",
        )
        .map((m) => ({ tenantId: m.tenantId, tenantName: m.tenantName })),
    [allMemberships, workbenchTenancyKinds.data],
  );
  if (memberships.kind !== "ready") return { kind: "loading", benches: [] };
  return { kind: "ready", benches };
}

export type GlobalRoutineRow = {
  readonly routine: Routine;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly deliveryWorkbenchName: string | null;
  readonly runs: readonly RoutineRun[];
};

type BenchRoutinesData = {
  readonly routines: readonly Routine[];
  readonly workbenchNames: ReadonlyMap<string, string>;
  readonly runHistories: ReadonlyMap<string, readonly RoutineRun[]>;
};

async function fetchBenchRoutinesData(
  tenantId: string,
): Promise<BenchRoutinesData> {
  const [routines, workbenches] = await Promise.all([
    listRoutines(tenantId),
    listWorkbenches(tenantId, "workbench"),
  ]);
  const runHistoryEntries = await Promise.all(
    routines.map(
      async (r) => [r.id, await listRoutineRuns(tenantId, r.id)] as const,
    ),
  );
  return {
    routines,
    workbenchNames: new Map(workbenches.map((w) => [w.id, w.title])),
    runHistories: new Map(runHistoryEntries),
  };
}

/** Every routine across every bench the account belongs to, flattened
 * into one list with its own workbench attribution — the aggregation
 * `GET /routines` doesn't do server-side (it's tenant-scoped, per bench),
 * done the cheapest correct client-side way: one fetch per bench, run in
 * parallel. */
function useGlobalRoutines(): APIQuery<readonly GlobalRoutineRow[]> {
  const { kind: benchesKind, benches } = useMemberBenches();
  const results = useQueries({
    queries: benches.map((bench) => ({
      queryKey: [...tenantKeys.routines(bench.tenantId), "global-page"],
      queryFn: () => fetchBenchRoutinesData(bench.tenantId),
    })),
  });

  if (benchesKind === "loading") return { kind: "loading" };
  if (results.some((r) => r.isLoading)) return { kind: "loading" };
  const failed = results.find((r) => r.isError);
  if (failed !== undefined) {
    return {
      kind: "error",
      message:
        failed.error instanceof Error
          ? failed.error.message
          : "Couldn't load routines.",
      retry: () => {
        for (const result of results) void result.refetch();
      },
    };
  }

  const rows: GlobalRoutineRow[] = [];
  benches.forEach((bench, index) => {
    const data = results[index]?.data;
    if (data === undefined) return;
    for (const routine of data.routines) {
      rows.push({
        routine,
        tenantId: bench.tenantId,
        tenantName: bench.tenantName,
        deliveryWorkbenchName:
          routine.deliveryWorkbenchId !== null
            ? (data.workbenchNames.get(routine.deliveryWorkbenchId) ?? null)
            : null,
        runs: data.runHistories.get(routine.id) ?? [],
      });
    }
  });
  return { kind: "ready", data: rows };
}

/** Idle/On/Off/Paused/Running/Failed — every row's own running-or-not
 * state at a glance, never a separate detail hop to find out. */
export function routineStateChip(row: GlobalRoutineRow): {
  readonly label: string;
  readonly tone: BadgeTone;
} {
  if (!row.routine.enabled) return { label: "Off", tone: "neutral" };
  if (row.routine.deadLetteredAt !== null) {
    return { label: "Paused", tone: "danger" };
  }
  const latest = row.runs[0];
  if (latest === undefined) return { label: "Idle", tone: "neutral" };
  const status = latest.run?.status;
  if (status === "running") return { label: "Running now", tone: "success" };
  if (
    (latest.error !== undefined && latest.error !== null) ||
    status === "failed"
  ) {
    return { label: "Last run failed", tone: "danger" };
  }
  return { label: "On", tone: "success" };
}

/** "Daily at 09:00 UTC, next in 3 hours" — consumer language throughout,
 * never a raw cron string. `approximateNextRun` and `cadenceLabel` are
 * this codebase's one source for either half. */
export function scheduleSummary(row: GlobalRoutineRow, now: number): string {
  const label = cadenceLabel(row.routine.trigger);
  const next = approximateNextRun(row.routine.trigger, new Date(now));
  if (next === null) return label;
  return `${label} · next ${formatRelativeTime(next.toISOString(), now)}`;
}

function RoutineRowDetail({
  row,
  now,
  onOpenWorkbench,
}: {
  readonly row: GlobalRoutineRow;
  readonly now: number;
  readonly onOpenWorkbench: (workbenchId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-4 py-3">
      {row.deliveryWorkbenchName !== null ? (
        <p className="m-0 text-xs text-[var(--ui-fg-muted)]">
          Run updates post into {row.deliveryWorkbenchName}.
        </p>
      ) : null}
      <RunsTable
        runs={row.runs.slice(0, 3)}
        now={now}
        emptyTitle="No runs yet"
        emptyDescription="This routine has not fired yet — manually or on a schedule."
        deliveryWorkbenchId={row.routine.deliveryWorkbenchId}
        onOpenWorkbench={onOpenWorkbench}
      />
    </div>
  );
}

export function GlobalRoutinesList({
  rows,
  now,
  expandedId,
  onToggleExpanded,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onOpenWorkbench,
}: {
  readonly rows: readonly GlobalRoutineRow[];
  readonly now: number;
  readonly expandedId: string | null;
  readonly onToggleExpanded: (routineId: string) => void;
  readonly onToggleEnabled: (row: GlobalRoutineRow, enabled: boolean) => void;
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
  readonly onEdit: (row: GlobalRoutineRow) => void;
  readonly onOpenWorkbench: (workbenchId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="No routines yet"
        description="Create one from a workflow or a prompt, in any workbench."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Routine</TableHead>
          <TableHead>Delivers to</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const chip = routineStateChip(row);
          const expanded = expandedId === row.routine.id;
          return (
            <Fragment key={row.routine.id}>
              <TableRow>
                <TableCell>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-left"
                    aria-expanded={expanded}
                    onClick={() => onToggleExpanded(row.routine.id)}
                  >
                    {expanded ? (
                      <CaretDown className="size-3.5 shrink-0" />
                    ) : (
                      <CaretRight className="size-3.5 shrink-0" />
                    )}
                    <span className="flex flex-col">
                      <span className="text-sm font-medium">
                        {row.routine.name}
                      </span>
                      <span className="text-xs text-[var(--ui-fg-muted)]">
                        {row.tenantName}
                      </span>
                    </span>
                  </button>
                </TableCell>
                <TableCell>
                  {row.routine.deliveryWorkbenchId !== null &&
                  row.deliveryWorkbenchName !== null ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto p-0 font-normal"
                      onClick={() =>
                        onOpenWorkbench(
                          row.routine.deliveryWorkbenchId as string,
                        )
                      }
                    >
                      {row.deliveryWorkbenchName}
                    </Button>
                  ) : (
                    <span className="text-sm text-[var(--ui-fg-muted)]">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-sm">{scheduleSummary(row, now)}</span>
                </TableCell>
                <TableCell>
                  <Badge tone={chip.tone}>{chip.label}</Badge>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={row.routine.enabled}
                    label={`${row.routine.enabled ? "Pause" : "Resume"} ${row.routine.name}`}
                    onCheckedChange={(enabled) => onToggleEnabled(row, enabled)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <RunNowButton
                      variant="outline"
                      size="sm"
                      onRun={() => onRunNow(row)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => onEdit(row)}
                    >
                      Edit
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {expanded ? (
                <TableRow>
                  <TableCell colSpan={6} className="p-0">
                    <RoutineRowDetail
                      row={row}
                      now={now}
                      onOpenWorkbench={onOpenWorkbench}
                    />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

const ROUTINES_PATH_PREFIX = "/routines";

/** A deep link into one routine (the context menu's "Open routine",
 * `/routines/:id` bookmarks) still lands here and expands that row — the
 * page itself is one flat list now, never a route per routine. */
function routineIdFromPath(path: string): string | null {
  if (!path.startsWith(`${ROUTINES_PATH_PREFIX}/`)) return null;
  const rest = path.slice(ROUTINES_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

export function RoutinesRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const routinesQuery = useGlobalRoutines();
  const queryClient = useQueryClient();
  const openRoutine = useOpenRoutineInCanvas();
  const { selectTenant } = useBench();
  const deepLinkedId = routineIdFromPath(path);
  const [expandedId, setExpandedId] = useState<string | null>(deepLinkedId);
  const now = Date.now();

  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];

  function invalidate(tenantId: string) {
    void queryClient.invalidateQueries({
      queryKey: [...tenantKeys.routines(tenantId), "global-page"],
    });
  }

  function openWorkbench(tenantId: string, workbenchId: string) {
    selectTenant(tenantId);
    navigate(workbenchPath(workbenchId));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title="Routines"
        subtitle={
          routinesQuery.kind === "ready"
            ? `${rows.length} automation${rows.length === 1 ? "" : "s"} across your workbenches`
            : null
        }
        actions={
          <Button size="sm" onClick={() => openRoutine({ routineId: null })}>
            New routine
          </Button>
        }
      />
      <div className="stage-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        {routinesQuery.kind === "loading" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon={<Clock />} title="Loading routines…" />
          </div>
        ) : routinesQuery.kind === "error" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <RichEmptyState
              icon={<Clock />}
              title="Couldn't load routines"
              description={routinesQuery.message}
            />
          </div>
        ) : (
          <GlobalRoutinesList
            rows={rows}
            now={now}
            expandedId={expandedId}
            onToggleExpanded={(routineId) =>
              setExpandedId((current) =>
                current === routineId ? null : routineId,
              )
            }
            onToggleEnabled={(row, enabled) => {
              void updateRoutine(row.tenantId, row.routine.id, {
                enabled,
              }).then(() => invalidate(row.tenantId));
            }}
            onRunNow={async (row) => {
              await runRoutineNow(row.tenantId, row.routine.id);
              invalidate(row.tenantId);
              toast(routineRunStartedToast(row.routine.name));
            }}
            onEdit={(row) =>
              openRoutine({
                routineId: row.routine.id,
                ...(row.routine.deliveryWorkbenchId !== null
                  ? { workbenchId: row.routine.deliveryWorkbenchId }
                  : {}),
              })
            }
            onOpenWorkbench={(workbenchId) => {
              const row = rows.find(
                (r) => r.routine.deliveryWorkbenchId === workbenchId,
              );
              if (row === undefined) return;
              openWorkbench(row.tenantId, workbenchId);
            }}
          />
        )}
      </div>
    </div>
  );
}
