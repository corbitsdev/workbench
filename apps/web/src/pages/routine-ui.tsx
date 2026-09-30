import "./routines.css";

import { Button } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { reportError } from "@corbits/error-sink";
import { WorkflowDefinitionResponse, WorkflowRunResponse, paginatedSchema } from "@intx/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@/lib/api-query";
import { tenantKeys } from "../query-client";
import { pauseSchedule, resumeSchedule } from "../routines-api";
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

const DefinitionsPageSchema = paginatedSchema(WorkflowDefinitionResponse);

/** The definition's own description, joined to the deployment by name (the
 * same join the cron row uses); null while loading or when it has none. */
export function useRoutineDescription(tenantId: string, name: string): string | null {
  const query = useAPIQuery(
    `/api/tenants/${tenantId}/workflows/definitions?limit=100`,
    DefinitionsPageSchema,
  );
  if (query.kind !== "ready") return null;
  const description = query.data.data.find((definition) => definition.name === name)?.description;
  return description === undefined || description === null || description === ""
    ? null
    : description;
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
  if (row.definition.status === "stopped" || !row.definition.scheduleEnabled)
    return { tone: "idle", label: "paused" };
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

/** Pauses or resumes the routine's cron schedule; absent when none exists. */
export function PauseResumeButton({ row }: { readonly row: GlobalRoutineRow }) {
  const queryClient = useQueryClient();
  const { scheduleId, scheduleEnabled, name } = row.definition;
  const toggle = useMutation({
    mutationFn: () =>
      (scheduleEnabled ? pauseSchedule : resumeSchedule)(row.tenantId, scheduleId ?? ""),
    onSuccess: () => toast(`${name} ${scheduleEnabled ? "paused" : "resumed"}`),
    onError: (cause) => {
      reportError(cause, { operation: "scheduled_workflow_toggle_pause", tenantId: row.tenantId });
      toast(`Couldn't update ${name}: ${describeApiError(cause, "updating this routine")}`);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: tenantKeys.routines(row.tenantId) }),
  });
  if (scheduleId === null || row.definition.status === "stopped") return null;
  return (
    <Button variant="outline" size="sm" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
      {scheduleEnabled ? "Pause" : "Resume"}
    </Button>
  );
}
