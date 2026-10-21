export type RoutineTone = "live" | "failed" | "info" | "idle";

export function isRunActive(status: string): boolean {
  return status === "running" || status === "updating";
}

export function isRunFailed(status: string): boolean {
  return status === "error" || status === "failed";
}

export function runOutcomeStatus(run: {
  readonly status: string;
  readonly endedAt?: string | null;
}): string {
  if (run.status === "running") {
    return typeof run.endedAt === "string" && run.endedAt !== "" ? "completed" : "running";
  }
  if (run.status === "error") return "failed";
  return run.status;
}

const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  running: "Running now",
  updating: "Running now",
  completed: "Finished",
  deployed: "Finished",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  stopped: "Stopped",
  queued: "Waiting to start",
  pending: "Waiting to start",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_WORDS[status] ?? status;
}

export function routineRunTone(status: string): RoutineTone {
  if (isRunFailed(status)) return "failed";
  if (isRunActive(status)) return "info";
  return status === "deployed" || status === "completed" ? "live" : "idle";
}

export function routineRunLabel(status: string): string {
  if (isRunFailed(status)) return "failed";
  return status === "deployed" || status === "completed" ? "ok" : status;
}

// The newest run's failure outranks the deployment's own state so a broken
// routine surfaces immediately even while its deployment stays registered.
export function routineState(
  row: {
    readonly definition: {
      readonly status: "deployed" | "stopped";
      readonly scheduleEnabled: boolean;
    };
  },
  lastRun: { readonly status: string } | undefined,
): { readonly tone: RoutineTone; readonly label: string } {
  if (lastRun !== undefined && isRunFailed(lastRun.status)) {
    return { tone: "failed", label: "failed" };
  }
  if (row.definition.status === "stopped" || !row.definition.scheduleEnabled) {
    return { tone: "idle", label: "paused" };
  }
  if (lastRun !== undefined && isRunActive(lastRun.status)) {
    return { tone: "info", label: "running" };
  }
  return { tone: "live", label: "live" };
}
