// The worker that carries a mail row out to whatever external places a
// principal has turned on. With no sink registered it has nothing to carry and
// finds nothing due, which is the correct steady state of a fresh install — a
// sink only exists once an operator adds one to the composition root.
import type { NotificationEvent } from "./events";
import type { SinkRegistry } from "./sinks";
import type { NotifyDispatchRow, NotifyDispatchStore } from "./store";

export interface NotifyDispatchLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface NotifyDispatcherDeps {
  readonly store: NotifyDispatchStore;
  readonly sinks: SinkRegistry;
  readonly log: NotifyDispatchLogger;
  /** Rebuilds the event a mail row came from, so a sink renders the same thing the mailbox shows. */
  readonly loadEvent: (
    row: NotifyDispatchRow,
  ) => Promise<NotificationEvent | null>;
  readonly tickIntervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
}

export interface NotifyDispatcher {
  /** Claim everything due once and deliver it; returns how many rows were settled. */
  runOnce(now: Date): Promise<number>;
  start(): void;
  stop(): void;
}

function backoffFrom(now: Date, attempts: number, baseMs: number): Date {
  return new Date(now.getTime() + baseMs * 2 ** (attempts - 1));
}

export function createNotifyDispatcher(
  deps: NotifyDispatcherDeps,
): NotifyDispatcher {
  let timer: ReturnType<typeof setInterval> | undefined;

  async function settleOne(row: NotifyDispatchRow, now: Date): Promise<void> {
    const attempts = row.attempts + 1;
    const sink = deps.sinks.get(row.sinkName);
    if (sink === undefined) {
      // The sink was removed from the composition root while rows were still
      // queued for it. Nothing can ever carry them, so they stop rather than
      // spinning forever.
      deps.log.warn(
        `Notification sink ${JSON.stringify(row.sinkName)} is no longer registered; ` +
          "its queued deliveries are closed out.",
      );
      await deps.store.settle({
        id: row.id,
        status: "dead",
        attempts,
        lastError: "sink is not registered",
        nextAttemptAt: now,
      });
      return;
    }

    const event = await deps.loadEvent(row);
    if (event === null) {
      await deps.store.settle({
        id: row.id,
        status: "dead",
        attempts,
        lastError: "the notification this delivery belongs to is gone",
        nextAttemptAt: now,
      });
      return;
    }

    const result = await sink
      .deliver({
        tenantId: row.tenantId,
        principalId: row.principalId,
        mailboxRowId: row.mailboxRowId,
        event,
      })
      .catch((error: unknown) => ({
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      }));

    if (result.status === "delivered") {
      await deps.store.settle({
        id: row.id,
        status: "delivered",
        attempts,
        lastError: null,
        nextAttemptAt: now,
      });
      return;
    }
    if (result.status === "skipped") {
      await deps.store.settle({
        id: row.id,
        status: "delivered",
        attempts,
        lastError: result.reason,
        nextAttemptAt: now,
      });
      return;
    }
    const exhausted = !result.retryable || attempts >= deps.maxAttempts;
    await deps.store.settle({
      id: row.id,
      status: exhausted ? "dead" : "failed",
      attempts,
      lastError: result.error,
      nextAttemptAt: exhausted
        ? now
        : backoffFrom(now, attempts, deps.retryBackoffMs),
    });
  }

  async function runOnce(now: Date): Promise<number> {
    const due = await deps.store.findDue(now, deps.batchSize);
    for (const row of due) await settleOne(row, now);
    return due.length;
  }

  return {
    runOnce,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void runOnce(new Date()).catch((error: unknown) => {
          deps.log.error(
            `Notification dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, deps.tickIntervalMs);
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
