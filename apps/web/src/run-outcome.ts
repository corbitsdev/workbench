export function runOutcomeStatus(run: {
  readonly status: string;
  readonly endedAt?: string | null;
}): string {
  if (run.status === "running" && typeof run.endedAt === "string" && run.endedAt !== "") {
    return "completed";
  }
  return run.status;
}

const RUN_STATUS_WORDS: Readonly<Record<string, string>> = {
  running: "Running now",
  updating: "Running now",
  completed: "Finished",
  failed: "Failed",
  error: "Failed",
  cancelled: "Cancelled",
  queued: "Waiting to start",
  pending: "Waiting to start",
};

export function runStatusLabel(status: string): string {
  return RUN_STATUS_WORDS[status] ?? status;
}
