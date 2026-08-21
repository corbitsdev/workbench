export interface CheckpointRecord {
  atMessages: number;
  wallClockMs: number;
  sendLatencyP50Ms: number;
  sendLatencyP95Ms: number;
  sendLatencyMaxMs: number;
  turnLatencyP50Ms: number;
  turnLatencyP95Ms: number;
  turnCount: number;
  firstTokenP50Ms: number;
  dbSizeBytes: number;
  messagePageMs: number;
  messagePageDeepMs: number;
  workbenchListMs: number;
  hubRssBytes: number;
  sidecarRssBytes: number;
  collectorFailures: number;
  routineFiresTotal: number;
  routineFiresAccepted: number;
  sendFailures: number;
  turnFailures: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)] ?? 0;
}

export interface Knee {
  metric: string;
  atMessages: number;
  baseline: number;
  value: number;
  ratio: number;
}

const KNEE_METRICS = [
  "sendLatencyP50Ms",
  "sendLatencyP95Ms",
  "turnLatencyP50Ms",
  "messagePageMs",
  "messagePageDeepMs",
  "workbenchListMs",
  "hubRssBytes",
  "dbSizeBytes",
] as const satisfies readonly (keyof CheckpointRecord)[];

export function findKnees(
  checkpoints: readonly CheckpointRecord[],
  opts?: { ratioThreshold?: number },
): Knee[] {
  const ratioThreshold = opts?.ratioThreshold ?? 3;
  const knees: Knee[] = [];
  for (const metric of KNEE_METRICS) {
    const baselineCheckpoint = checkpoints.find(
      (checkpoint) => checkpoint[metric] !== 0,
    );
    if (baselineCheckpoint === undefined) continue;
    const baseline = baselineCheckpoint[metric];
    for (const checkpoint of checkpoints) {
      if (checkpoint.atMessages <= baselineCheckpoint.atMessages) continue;
      const value = checkpoint[metric];
      const ratio = value / baseline;
      if (ratio >= ratioThreshold) {
        knees.push({
          metric,
          atMessages: checkpoint.atMessages,
          baseline,
          value,
          ratio,
        });
        break;
      }
    }
  }
  return knees;
}
