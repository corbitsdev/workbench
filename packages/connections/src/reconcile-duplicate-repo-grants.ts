// One-time cleanup for pre-existing duplicate `repo:<owner/name>`
// grants a database can already carry from CL-7242's check-then-act
// race, before this fix's lease (`@corbits/webhook-triggers`'
// `repo_review_lease`) started preventing new ones.
//
// This is ordinary application code, not a migration: a plain DELETE
// against Interchange's own `grant` table, issued through `@intx/db`'s
// published `grant` export — the exact same table object
// `apps/hub/src/index.ts` already reads and writes through for every
// other grant operation in this codebase. No schema is touched (no
// `ALTER TABLE`, no index, no constraint), so this creates no re-pin
// debt: a DDL delta would need hand-reapplying at every future
// `vendor/intx/*` re-pin, but a DML statement runs once and leaves
// nothing behind for a re-pin to reconcile. Deliberately safe to
// re-run — a database with no duplicates left just deletes nothing.
import postgres from "postgres";

export interface ReconcileDuplicateRepoGrantsReport {
  /** Ids of the duplicate rows removed, kept for the caller to log. */
  readonly removedIds: readonly string[];
}

/**
 * Keeps the lowest-`id` row per `(tenant_id, resource, action)` among
 * `repo:`-prefixed grants with an origin `mintRepoGrant` could plausibly
 * have written and deletes the rest. `'creator'` is what the current
 * `mintRepoGrantViaHttp` path (`apps/hub/src/native-repo-grants.ts`)
 * writes; `'system'` is what the direct-insert path this PR replaced
 * used to write, so a database carrying duplicates from either
 * generation of this feature gets them cleaned up. Never touches any
 * other grant family.
 */
export async function reconcileDuplicateRepoGrants(
  databaseUrl: string,
): Promise<ReconcileDuplicateRepoGrantsReport> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    const removed = await sql<{ id: string }[]>`
      DELETE FROM "grant" AS g
      USING "grant" AS older
      WHERE g.origin IN ('system', 'creator')
        AND g.resource LIKE 'repo:%'
        AND older.origin IN ('system', 'creator')
        AND older.resource LIKE 'repo:%'
        AND g.tenant_id = older.tenant_id
        AND g.resource = older.resource
        AND g.action = older.action
        AND older.id < g.id
      RETURNING g.id
    `;
    return { removedIds: removed.map((row) => row.id) };
  } finally {
    await sql.end();
  }
}
