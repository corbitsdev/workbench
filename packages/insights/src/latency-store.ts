// Package-owned store for per-message-run turn latency (CL-6257): the
// wall-clock gap between a message reaching the reactor and its reply
// posting back, broken into the stages a turn actually passes through.
// Mirrors `store.ts`'s UsageStore shape — same idempotent-insert-by-key,
// same in-memory/drizzle split — so the two sinks read the same way at
// every call site that already knows one.

export type TurnLatencyRecord = {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly messageRunId: string;
  readonly status: "completed" | "failed";
  /** Wall-clock the reactor's director dequeued the inbound message. */
  readonly receivedAt: Date;
  /**
   * When the reactor itself (re)started for this connection. Null on
   * every message after the first in a session the reactor kept warm
   * for — only a cold start (a fresh session, e.g. the greeting) pays
   * this stage, so absence here is the common, honest case, not a gap.
   */
  readonly reactorStartAt: Date | null;
  readonly inferenceStartAt: Date | null;
  readonly firstTokenAt: Date | null;
  readonly replyPostedAt: Date;
};

export type InsertTurnLatencyInput = {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly messageRunId: string;
  readonly status: "completed" | "failed";
  readonly receivedAt: Date;
  readonly reactorStartAt: Date | null;
  readonly inferenceStartAt: Date | null;
  readonly firstTokenAt: Date | null;
  readonly replyPostedAt: Date;
};

export type TurnLatencyStore = {
  /** Insert a message run's latency row. Returns null if messageRunId
   * already exists (idempotent — a dispatch retry never double-counts). */
  insertLatency(
    input: InsertTurnLatencyInput,
  ): Promise<TurnLatencyRecord | null>;
  listLatencyByTenants(
    tenantIds: readonly string[],
    opts?: { from?: Date; to?: Date },
  ): Promise<readonly TurnLatencyRecord[]>;
};

/** In-memory store for unit tests and local smoke. */
export function createMemoryTurnLatencyStore(): TurnLatencyStore {
  const rows = new Map<string, TurnLatencyRecord>();
  const byMessageRunId = new Map<string, string>();

  return {
    async insertLatency(input) {
      if (byMessageRunId.has(input.messageRunId)) return null;
      const record: TurnLatencyRecord = { ...input };
      rows.set(record.id, record);
      byMessageRunId.set(record.messageRunId, record.id);
      return record;
    },
    async listLatencyByTenants(tenantIds, opts) {
      const scope = new Set(tenantIds);
      return [...rows.values()]
        .filter((r) => scope.has(r.tenantId))
        .filter((r) =>
          opts?.from === undefined ? true : r.receivedAt >= opts.from,
        )
        .filter((r) =>
          opts?.to === undefined ? true : r.receivedAt <= opts.to,
        )
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
    },
  };
}
