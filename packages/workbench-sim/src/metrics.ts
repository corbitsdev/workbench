// Pure assertion/metric helpers over what a run actually recorded.
// Everything here is a function of plain data so the checks are
// unit-testable against hand-built runs; only the runner collects.

export interface SentMessage {
  ref?: string;
  actor: string;
  text: string;
  messageId: string;
  /** Thread the server filed this message under (replies only). */
  threadId?: string;
  /** messageId of the root this message replied to (replies only). */
  inReplyToMessageId?: string;
  /** POST send -> 201 persisted, in milliseconds. */
  latencyMs: number;
}

export interface RoutineFireRecord {
  routine: string;
  runId: string;
  accepted: boolean;
}

export interface CollectedRun {
  scenarioName: string;
  sent: readonly SentMessage[];
  /** Every message id visible on the channel timeline at the end. */
  timelineMessageIds: ReadonlySet<string>;
  routineFires: readonly RoutineFireRecord[];
  dbRowsBefore: number;
  dbRowsAfter: number;
  wallClockMs: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  const value = sorted[Math.max(0, index)];
  return value ?? 0;
}

/** Sends whose 201-persisted id never showed up on the final timeline. */
export function droppedMessages(
  sent: readonly SentMessage[],
  timelineMessageIds: ReadonlySet<string>,
): SentMessage[] {
  return sent.filter((message) => !timelineMessageIds.has(message.messageId));
}

/** Thread integrity: every reply landed in the same thread as every
 * other reply to the same root, and never in a sibling root's thread.
 * Returns human-readable violations (empty = intact). */
export function threadViolations(sent: readonly SentMessage[]): string[] {
  const violations: string[] = [];
  const threadByRoot = new Map<string, string>();
  for (const message of sent) {
    if (message.inReplyToMessageId === undefined) continue;
    if (message.threadId === undefined) {
      violations.push(
        `reply ${message.messageId} to ${message.inReplyToMessageId} came back with no threadId`,
      );
      continue;
    }
    const known = threadByRoot.get(message.inReplyToMessageId);
    if (known === undefined) {
      for (const [root, thread] of threadByRoot) {
        if (
          thread === message.threadId &&
          root !== message.inReplyToMessageId
        ) {
          violations.push(
            `reply ${message.messageId} to root ${message.inReplyToMessageId} landed in thread ${thread} already owned by root ${root}`,
          );
        }
      }
      threadByRoot.set(message.inReplyToMessageId, message.threadId);
    } else if (known !== message.threadId) {
      violations.push(
        `reply ${message.messageId} to root ${message.inReplyToMessageId} landed in thread ${message.threadId}, expected ${known}`,
      );
    }
  }
  return violations;
}

export interface RunMetrics {
  messageCount: number;
  threadReplyCount: number;
  routineFireCount: number;
  routineFiresAccepted: number;
  dropCount: number;
  threadViolations: readonly string[];
  latencyP50Ms: number;
  latencyP95Ms: number;
  dbRowGrowth: number;
  wallClockMs: number;
}

export function computeMetrics(run: CollectedRun): RunMetrics {
  const latencies = run.sent.map((message) => message.latencyMs);
  return {
    messageCount: run.sent.length,
    threadReplyCount: run.sent.filter(
      (message) => message.inReplyToMessageId !== undefined,
    ).length,
    routineFireCount: run.routineFires.length,
    routineFiresAccepted: run.routineFires.filter((fire) => fire.accepted)
      .length,
    dropCount: droppedMessages(run.sent, run.timelineMessageIds).length,
    threadViolations: threadViolations(run.sent),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    dbRowGrowth: run.dbRowsAfter - run.dbRowsBefore,
    wallClockMs: run.wallClockMs,
  };
}

export interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

/** The green/red gate a scenario run is judged by. */
export function assertRun(
  metrics: RunMetrics,
  expected: {
    minMessages: number;
    minThreadReplies: number;
    minRoutineFires: number;
  },
): AssertionResult[] {
  return [
    {
      name: "message volume",
      pass: metrics.messageCount >= expected.minMessages,
      detail: `${metrics.messageCount} sent (needed >= ${expected.minMessages})`,
    },
    {
      name: "thread replies",
      pass: metrics.threadReplyCount >= expected.minThreadReplies,
      detail: `${metrics.threadReplyCount} replies (needed >= ${expected.minThreadReplies})`,
    },
    {
      name: "thread integrity",
      pass: metrics.threadViolations.length === 0,
      detail:
        metrics.threadViolations.length === 0
          ? "every reply landed in its root's thread"
          : metrics.threadViolations.join("; "),
    },
    {
      name: "no drops",
      pass: metrics.dropCount === 0,
      detail: `${metrics.dropCount} persisted sends missing from the final timeline`,
    },
    {
      name: "routine fires",
      pass:
        metrics.routineFireCount >= expected.minRoutineFires &&
        metrics.routineFiresAccepted === metrics.routineFireCount,
      detail: `${metrics.routineFiresAccepted}/${metrics.routineFireCount} accepted (needed >= ${expected.minRoutineFires})`,
    },
    {
      name: "rows grew",
      pass: metrics.dbRowGrowth > 0,
      detail: `${metrics.dbRowGrowth} new rows`,
    },
  ];
}
