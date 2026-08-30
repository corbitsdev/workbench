// A minimal periodic loop that reopens a snoozed inbox item once its
// `until` has passed (CL-7208) — mirroring `credential-expiry-sweep.ts`
// and `routine-scheduler.ts`, the only other periodic loops in this hub,
// rather than standing up a new generic scheduling primitive. Neither
// `@corbits/notify`'s `createNotifyDispatcher` (shaped around sink
// delivery — attempts, backoff, a `SinkRegistry` — not a status flip) nor
// the routine scheduler (`RoutineStore` is routine-domain-specific) fits
// "reopen a mailbox row when its snooze timer elapses" without bending
// their semantics, so this repeats the same small `setInterval` + own
// due-scan shape those two already use.
//
// `claimAndReopenSnooze` (in `@corbits/inbox`) does the actual claim: a
// single transaction that deletes the due snooze row and flips the
// message back to `open` together, so a throw here rolls back both and
// leaves the row for the next tick to retry rather than orphaning it —
// the mail-then-claim lesson CL-7209 applied to the credential-expiry
// sweep, applied here to the claim itself.
import { getLogger } from "@intx/log";
import { reportError } from "@corbits/error-sink";
import {
  claimAndReopenSnooze,
  findDueSnoozes,
  type DueSnooze,
} from "@corbits/inbox";
import type { MailboxDb, MailboxEventBus } from "@corbits/mailbox";

export type InboxUnsnoozeSweepStore = {
  findDueSnoozes(now: Date): Promise<readonly DueSnooze[]>;
  /** Atomically claims one due snooze row and reopens its message if it's
   * still snoozed. Returns whether it actually reopened something — see
   * `claimAndReopenSnooze`'s own doc comment for the false cases. */
  claimAndReopen(row: DueSnooze, now: Date): Promise<boolean>;
};

export function createDrizzleInboxUnsnoozeSweepStore(
  db: MailboxDb,
): InboxUnsnoozeSweepStore {
  return {
    findDueSnoozes: (now) => findDueSnoozes(db, now),
    claimAndReopen: (row, now) => claimAndReopenSnooze(db, row, now),
  };
}

export type InboxUnsnoozeSweepDeps = {
  store: InboxUnsnoozeSweepStore;
  bus: Pick<MailboxEventBus, "publish">;
  /** Injectable for deterministic tests; defaults to `Date.now`-backed wall time. */
  now?: () => Date;
};

const POLL_INTERVAL_MS = 60 * 1000;
const publishLog = getLogger(["hub", "inbox-unsnooze-sweep"]);

function publishReopened(
  bus: Pick<MailboxEventBus, "publish">,
  row: DueSnooze,
): void {
  // Best-effort, matching every other mailbox event publish in this repo
  // (see packages/inbox/src/routes.ts's own `publish` helper): a bus
  // failure here must never turn an already-committed reopen into a
  // reported sweep failure.
  try {
    bus.publish(
      { tenantId: row.tenantId, principalId: row.principalId },
      { type: "mailbox", id: row.messageId, op: "enrich" },
    );
  } catch (error) {
    publishLog.error(
      "mailbox reopen event publish failed for {id} on tenant {tenantId}, principal {principalId}: {error}",
      {
        id: row.messageId,
        tenantId: row.tenantId,
        principalId: row.principalId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/**
 * One sweep: reopen every snooze due at `at`. Exported (rather than kept
 * as a closure) so a test can drive a single, deterministic pass without
 * waiting on `setInterval`.
 */
export async function tickInboxUnsnoozeSweep(
  deps: Pick<InboxUnsnoozeSweepDeps, "store" | "bus">,
  at: Date,
): Promise<void> {
  const due = await deps.store.findDueSnoozes(at);
  for (const row of due) {
    try {
      const reopened = await deps.store.claimAndReopen(row, at);
      if (reopened) publishReopened(deps.bus, row);
    } catch (error) {
      reportError(error, {
        operation: "inbox_unsnooze_sweep",
        tenantId: row.tenantId,
        extra: { messageId: row.messageId },
      });
      // The claim is transactional (delete + reopen together): a throw
      // means neither happened, so the row is still there and the next
      // tick retries it instead of leaving the item snoozed forever.
    }
  }
}

export function createInboxUnsnoozeSweep(deps: InboxUnsnoozeSweepDeps) {
  const now = deps.now ?? (() => new Date());
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tickInboxUnsnoozeSweep({ store: deps.store, bus: deps.bus }, now());
    } catch (err) {
      reportError(err, { operation: "inbox_unsnooze_sweep_tick" });
    } finally {
      tickInFlight = false;
    }
  }

  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    tick,
    stop(): void {
      clearInterval(interval);
    },
  };
}
