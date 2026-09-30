import "./routines.css";

import { WorkflowRunResponse, paginatedSchema } from "@intx/types";
import { useAPIQuery } from "../api";
import type { APIQuery } from "@/lib/api-query";
import type { GlobalRoutineRow } from "../global-routines";

export const RunsPageSchema = paginatedSchema(WorkflowRunResponse);
export type RunRow = typeof WorkflowRunResponse.infer;

export function runsPath(tenantId: string, definitionId: string, limit: number): string {
  return `/api/tenants/${tenantId}/workflows/runs?definitionId=${encodeURIComponent(definitionId)}&limit=${String(limit)}`;
}

export function useRoutineRuns(
  tenantId: string,
  definitionId: string,
  limit: number,
): APIQuery<typeof RunsPageSchema.infer> {
  return useAPIQuery(runsPath(tenantId, definitionId, limit), RunsPageSchema);
}

export function formatWhen(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type Tone = "live" | "failed" | "info" | "idle";

/** The row's state: the newest run's failure outranks the deployment's own. */
export function routineState(
  row: GlobalRoutineRow,
  lastRun: RunRow | undefined,
): { readonly tone: Tone; readonly label: string } {
  if (lastRun?.status === "error") return { tone: "failed", label: "failed" };
  if (row.definition.status === "stopped") return { tone: "idle", label: "paused" };
  if (lastRun?.status === "running" || lastRun?.status === "updating") {
    return { tone: "info", label: "running" };
  }
  return { tone: "live", label: "live" };
}

export function RoutinePill({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: string;
}) {
  return (
    <span className="routine-pill" data-tone={tone}>
      {children}
    </span>
  );
}
