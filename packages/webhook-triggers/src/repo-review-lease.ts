// Closes a check-then-act race in the GitHub connect card's
// start-reviewing step (CL-7242): `startReviewingRepos`
// (`@workbench/connections`) loops over selected repos doing
// hasRepoGrant/mintRepoGrant then hasWebhookTrigger/createWebhookTrigger
// per repo, each a plain read followed by a conditional write with no
// atomic backstop. Two concurrent calls for the same repo (a
// double-click, or a client retrying an in-flight request) can both
// read "not set up yet" before either write lands, so both mint a
// grant and both create a trigger.
//
// A lease acquired before that per-repo body runs is the actual
// backstop: only the caller that wins the lease proceeds into
// hasRepoGrant/mintRepoGrant/hasWebhookTrigger/createWebhookTrigger,
// which stay exactly as CL-7134 left them (a fast path for a
// *sequential* retry after a mid-loop failure, safe now that they can
// never run concurrently for the same repo). The lease is released as
// soon as that body finishes (success or failure) so a legitimate
// retry is never blocked by its own prior attempt; a 2-minute
// staleness window is a crash-only backstop, in case a process dies
// before its `finally` can run.
//
// This table carries no schema-level relationship to Interchange's
// own `grant` table (or any other platform table): the workaround
// this closes lives entirely in workbench-owned state, and the actual
// source of truth for whether a repo's grant/trigger exist stays
// `hasRepoGrant`/`hasWebhookTrigger` against the real platform data,
// completely unchanged. The lease only ever asserts "someone claimed
// responsibility for this repo's setup as of `leasedAt`" — never
// "the grant/trigger exist" — so it can never assert something untrue
// the way a stale "done" marker could (CL-7213's own precedent).
import { and, eq, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { repoReviewLease } from "./schema";

export type RepoReviewLeaseDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

/** Comfortably longer than a single repo's synchronous mint-and-create
 * work should ever take, so a live lease is never mistaken for stale;
 * short enough that a crashed holder self-heals well within a person
 * re-clicking "Start reviewing" a few times. */
const LEASE_STALE_AFTER_MS = 2 * 60 * 1000;

export interface RepoReviewLeaseStore {
  /**
   * True if this call now holds the lease on `(tenantId, repo)` —
   * either no lease existed, or the existing one is older than the
   * staleness window and was stolen. False means another call
   * currently holds (or very recently held) it; the caller must skip
   * this repo rather than proceed.
   */
  acquire(tenantId: string, repo: string): Promise<boolean>;
  /** Releases a held lease so an immediate legitimate retry (e.g. the
   * next repo in a fresh `startReviewingRepos` call) never waits out
   * the staleness window. Safe to call even if this caller never held
   * the lease (e.g. `acquire` returned false) — a no-op in that case. */
  release(tenantId: string, repo: string): Promise<void>;
}

export function createDrizzleRepoReviewLeaseStore<
  TSchema extends Record<string, unknown>,
>(db: RepoReviewLeaseDb<TSchema>): RepoReviewLeaseStore {
  return {
    async acquire(tenantId, repo) {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - LEASE_STALE_AFTER_MS);
      // Insert-first with a conditional steal, not select-then-insert:
      // the unique index on (tenant_id, repo) makes this one atomic
      // compare-and-swap on the DB side. The insert succeeds when no
      // row exists yet; the `DO UPDATE ... WHERE` steals an existing
      // row only when it's stale, and otherwise leaves it untouched
      // and returns nothing — Postgres, not app-level timing, decides
      // who wins.
      const rows = await db
        .insert(repoReviewLease)
        .values({
          id: `lease_${crypto.randomUUID()}`,
          tenantId,
          repo,
          leasedAt: now,
        })
        .onConflictDoUpdate({
          target: [repoReviewLease.tenantId, repoReviewLease.repo],
          set: { leasedAt: now },
          where: lt(repoReviewLease.leasedAt, staleBefore),
        })
        .returning({ id: repoReviewLease.id });
      return rows.length > 0;
    },

    async release(tenantId, repo) {
      await db
        .delete(repoReviewLease)
        .where(
          and(
            eq(repoReviewLease.tenantId, tenantId),
            eq(repoReviewLease.repo, repo),
          ),
        );
    },
  };
}
