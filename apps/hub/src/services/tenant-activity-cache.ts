import type { TimelineCursor } from "@workbench/timeline";

import { getConfig } from "../config";
import type { HubDb } from "../db";
import { createTtlMemo } from "../lib/ttl-memo";
import {
  getTenantActivityPage,
  type PrincipalActivityPage,
} from "./principal-activity";

// Progressive loading + cache (CL-2753). The tenant-wide activity feed runs the
// heaviest Insights query — a per-row UNION across interchange-owned tables we
// are not allowed to index. The frontend already defers it behind a disclosure
// (loaded on demand, not on every open); this adds a short in-process TTL memo
// so that when several members of a busy tenant open the feed inside the same
// window, they collapse onto ONE DB union instead of one union per open.
//
// Scope is deliberately narrow to stay correct:
//   - Only the tenant-wide FIRST page (no cursor) is cached. Deep pages are
//     per-user, rare, and keyset-unique, so caching them earns nothing and
//     would balloon the map.
//   - The key is `${tenantId}:${limit}`, so a cached page can never cross the
//     tenant boundary (cross-tenant isolation, CL-2738 stays airtight).
//   - `getTenantActivityPage` always runs with `TENANT_WIDE_SCOPE`, whose
//     summaries are already F2-redacted (memory content / credential names
//     dropped). The per-principal drill-down uses a DIFFERENT function
//     (`getPrincipalActivityPage`, full unredacted text) and never touches this
//     cache — so a redacted tenant-wide page can never leak into, nor be
//     served from, an authz-scoped drill-down.
//
// In-process only: the hub has no redis (see docs/ANALYTICS.md), mirroring the
// models.dev pricing TTL cache in `lib/pricing.ts`.

// Bounds the resident key count across `${tenantId}:${limit}` combinations.
// The frontend only ever requests a small, fixed set of page-size limits, so
// this many tenants-times-limit-variants is a generous ceiling in practice —
// it exists to stop unbounded growth over a hub's lifetime, not to constrain
// normal usage.
const MAX_ENTRIES = 200;

const memo = createTtlMemo<PrincipalActivityPage>({ maxEntries: MAX_ENTRIES });

/** Test-only: clears the tenant-activity cache. */
export function resetTenantActivityCache(): void {
  memo.reset();
}

export async function getCachedTenantActivityPage(args: {
  db: HubDb;
  tenantId: string;
  limit: number;
  cursor?: TimelineCursor;
  ttlMs?: number;
  now?: () => number;
}): Promise<PrincipalActivityPage> {
  // Only the first page is cacheable; deep cursor pages always hit the DB.
  if (args.cursor !== undefined) {
    return getTenantActivityPage({
      db: args.db,
      tenantId: args.tenantId,
      limit: args.limit,
      cursor: args.cursor,
    });
  }

  const ttlMs = args.ttlMs ?? getConfig().insights.tenantActivityCacheTtlMs;
  const key = `${args.tenantId}:${args.limit}`;

  return memo.get({
    key,
    ttlMs,
    now: args.now,
    resolve: () =>
      getTenantActivityPage({
        db: args.db,
        tenantId: args.tenantId,
        limit: args.limit,
      }),
  });
}
