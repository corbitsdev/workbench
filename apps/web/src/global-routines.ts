// Every routine across every bench the signed-in account belongs to, as
// one flat list — the aggregation both routines surfaces read from: the
// roster at `/routines` and the detail page at `/routines/<slug>`.
//
// It lives here rather than inside `pages/routines-page.tsx` because the
// detail page needs the identical resolution (a slug names a routine in
// *some* bench, not in the currently selected one) and two copies of a
// membership fan-out would drift the moment either page changed which
// benches it looks in.
//
// Visibility resolves through the same membership the sidebar's bench
// switcher uses (`useBench().memberships`, the `/api/me/principals` /
// CL-6332 principal model), filtered to actual benches with
// `classifyBenchMembership` — never just the currently selected one, and
// never creator-scoped: `GET /routines` already lists every routine a
// bench's own grant covers, regardless of who created it.
import { listWorkbenches } from "@corbits/chat-ui";
import {
  classifyBenchMembership,
  listWorkbenchTenantIds,
} from "@corbits/bench-ui";
import {
  routineActionFailedToast,
  routineRunStartedToast,
  routineSlug,
  timezoneForTrigger,
} from "@corbits/routines/client";
import { toast } from "@corbits/react-ui";
import { useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@corbits/api-query";
import type { APIQuery } from "@corbits/api-query";

import type { Principal } from "./api";
import { useBench } from "./bench-context";
import { ROUTINES_PATH_PREFIX } from "./path-ids";
import { meKeys, tenantKeys } from "./query-client";
import {
  listRoutineRuns,
  listRoutines,
  runRoutineNow,
  updateRoutine,
} from "./routines-api";
import type { Routine, RoutineRun } from "./routines-api";

/** The query-key suffix both routines surfaces share, so a mutation on
 * either invalidates the other's copy of the same fetch. */
const ROUTINES_QUERY_SCOPE = "global-page";

export type GlobalRoutineRow = {
  readonly routine: Routine;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly deliveryWorkbenchName: string | null;
  readonly runs: readonly RoutineRun[];
};

/**
 * A routine's own page. Addressed by id, which is the only address a
 * routine actually has: DESIGN.md permits a slug in a route only where it
 * is immutable and tenant-unique by hard database constraint, and a
 * routine has no slug column — so a name-derived slug is the soft
 * convention that rule forbids, and the opaque id is the documented
 * fallback. `routineSlugPath` below still builds the name address, for
 * resolving links people typed or shared.
 */
export function routineDetailPath(routineId: string): string {
  return `${ROUTINES_PATH_PREFIX}/${encodeURIComponent(routineId)}`;
}

/** The name-derived address a person may have typed or shared — resolved
 * and redirected to `routineDetailPath` by the detail route, never
 * rendered as canonical. `null` when the name has nothing sluggable in
 * it. */
export function routineSlugPath(name: string): string | null {
  const slug = routineSlug(name);
  return slug === "" ? null : `${ROUTINES_PATH_PREFIX}/${slug}`;
}

/** The rows whose routine answers to `slug`. More than one means two
 * routines share a name — the caller says so rather than silently picking
 * one (DESIGN.md: a route never invents a slug that might collide). */
export function rowsForSlug(
  rows: readonly GlobalRoutineRow[],
  slug: string,
): readonly GlobalRoutineRow[] {
  return rows.filter((row) => routineSlug(row.routine.name) === slug);
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
 * parallel. A server-side health summary that collapses this fan-out into
 * a single request is ticketed separately; it changes where the numbers
 * are computed, not what they mean. */
export function useGlobalRoutines(): APIQuery<readonly GlobalRoutineRow[]> {
  const { kind: benchesKind, benches } = useMemberBenches();
  const results = useQueries({
    queries: benches.map((bench) => ({
      queryKey: [...tenantKeys.routines(bench.tenantId), ROUTINES_QUERY_SCOPE],
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

/** Refetch one bench's routines after a mutation on either surface. */
export function useInvalidateRoutines(): (tenantId: string) => void {
  const queryClient = useQueryClient();
  return (tenantId: string) => {
    void queryClient.invalidateQueries({
      queryKey: [...tenantKeys.routines(tenantId), ROUTINES_QUERY_SCOPE],
    });
  };
}

export type RoutineActions = {
  /** Toasts and resolves on failure — the caller has no second thing to
   * say, and an unhandled rejection is not a user-facing error message. */
  readonly runNow: (row: GlobalRoutineRow) => Promise<void>;
  readonly setEnabled: (
    row: GlobalRoutineRow,
    enabled: boolean,
  ) => Promise<void>;
  /** Toasts and *rethrows*, so a schedule editor can also keep the draft
   * on screen and say what happened next to the field. */
  readonly saveCronSchedule: (
    row: GlobalRoutineRow,
    expression: string,
  ) => Promise<void>;
};

/**
 * The three routine mutations, each of which reports its own failure.
 * Shared by the roster and the detail page so a refused write reads the
 * same on both, and so neither surface can quietly drop one: every path
 * here either invalidates on success or says what went wrong in words.
 * Nothing is applied optimistically — the row changes when the hub says
 * it changed.
 */
export function useRoutineActions(): RoutineActions {
  const invalidate = useInvalidateRoutines();
  return {
    runNow: async (row) => {
      try {
        await runRoutineNow(row.tenantId, row.routine.id);
        invalidate(row.tenantId);
        toast(routineRunStartedToast(row.routine.name));
      } catch (cause) {
        toast(
          routineActionFailedToast(
            "run",
            row.routine.name,
            describeApiError(cause, "starting this routine"),
          ),
        );
      }
    },
    setEnabled: async (row, enabled) => {
      try {
        await updateRoutine(row.tenantId, row.routine.id, { enabled });
        invalidate(row.tenantId);
      } catch (cause) {
        toast(
          routineActionFailedToast(
            enabled ? "resume" : "pause",
            row.routine.name,
            describeApiError(
              cause,
              enabled ? "resuming this routine" : "pausing this routine",
            ),
          ),
        );
      }
    },
    saveCronSchedule: async (row, expression) => {
      const timezone = timezoneForTrigger(row.routine.trigger);
      try {
        await updateRoutine(row.tenantId, row.routine.id, {
          trigger:
            timezone === "UTC"
              ? { kind: "cron", expression }
              : { kind: "cron", expression, timezone },
        });
      } catch (cause) {
        toast(
          routineActionFailedToast(
            "schedule",
            row.routine.name,
            describeApiError(cause, "saving this schedule"),
          ),
        );
        throw cause;
      }
      invalidate(row.tenantId);
    },
  };
}
