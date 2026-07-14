import { eq } from "drizzle-orm";
import { getLogger } from "@intx/log";
import { inboxIntakeCursor } from "../db/schema";
import type { HubDb } from "../db";

const log = getLogger(["hub", "inbox-intake-cursor"]);

/**
 * Durable replacement for inbox-intake's in-process `lastPollAtByScopeKey` map
 * (CL-3628) — a per-process Map resets to a wide `lookbackMs` poll on every
 * restart/redeploy, and does nothing to stop two replicas polling the same
 * scope concurrently. This module persists one row per scope key and adds a
 * Postgres advisory lock so only one replica runs a tick at a time.
 */

// Reads the persisted cursor for one scope key (`member:<principalId>:<source>`
// or `workspace:<tenantId>:<source>` — the same keys inbox-intake.ts already
// builds). Returns undefined when no poll has ever succeeded for this scope,
// which callers fall back to the tick's `lookbackMs` cutoff for, exactly as
// the in-memory map's "no entry" case did.
export async function readInboxIntakeCursor(
  db: HubDb,
  scopeKey: string,
): Promise<Date | undefined> {
  const row = await db.query.inboxIntakeCursor.findFirst({
    where: eq(inboxIntakeCursor.scopeKey, scopeKey),
  });
  return row?.lastPollAt;
}

// Upserts the cursor for one scope key. Callers set this ONLY after a source
// handler resolves without throwing — a failed poll must never advance past
// work it never actually delivered (same contract the in-memory map enforced).
export async function writeInboxIntakeCursor(
  db: HubDb,
  scopeKey: string,
  tenantId: string,
  lastPollAt: Date,
): Promise<void> {
  await db
    .insert(inboxIntakeCursor)
    .values({ scopeKey, tenantId, lastPollAt })
    .onConflictDoUpdate({
      target: inboxIntakeCursor.scopeKey,
      set: { tenantId, lastPollAt, updatedAt: new Date() },
    });
}

// Arbitrary, stable advisory-lock key for the inbox-intake tick (CL-3628 —
// there is no other advisory lock in this codebase yet to collide with).
// Session-scoped (not `_xact_lock`): the tick performs many independent
// statements over the pool, not one transaction, so the lock is held on a
// single reserved connection for the tick's full duration and released
// explicitly, rather than tied to a transaction boundary this code doesn't have.
const TICK_LOCK_KEY = 36_281_001;

/**
 * Runs `fn` while holding the tick's Postgres advisory lock, reserving a
 * dedicated connection so the lock's session lifetime doesn't get confused
 * with the shared pool. If another replica (or an overlapping call in this
 * process) already holds the lock, this is a legible no-op — the caller's
 * next scheduled tick retries.
 */
export async function withInboxIntakeTickLock(
  db: HubDb,
  fn: () => Promise<void>,
): Promise<void> {
  // `reserve()` is postgres.js-specific; the PGlite driver our integration
  // tests run against (no separate connections to arbitrate between) has no
  // such method. Skipping the lock there is safe — those tests only ever run
  // a single tick at a time — and keeps this module usable in production
  // (always a real postgres.js pool) without forcing every test double to
  // fake a connection-reservation API just to exercise unrelated behavior.
  if (typeof db.$client?.reserve !== "function") {
    await fn();
    return;
  }
  const reserved = await db.$client.reserve();
  try {
    const [row] =
      await reserved`select pg_try_advisory_lock(${TICK_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      log.info("inbox intake: tick lock held by another replica; skipping");
      return;
    }
    try {
      await fn();
    } finally {
      await reserved`select pg_advisory_unlock(${TICK_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}
