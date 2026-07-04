import type { TimelineCursor } from "@workbench/timeline";

import { getConfig } from "../config";
import type { HubDb } from "../db";
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

type CacheEntry = { page: PrincipalActivityPage; storedAt: number };

const cache = new Map<string, CacheEntry>();
let inflight = new Map<string, Promise<PrincipalActivityPage>>();

/** Test-only: clears the tenant-activity cache. */
export function resetTenantActivityCache(): void {
  cache.clear();
  inflight = new Map();
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
  const clock = args.now ?? Date.now;
  const key = `${args.tenantId}:${args.limit}`;

  const cached = cache.get(key);
  if (cached !== undefined && clock() - cached.storedAt < ttlMs) {
    return cached.page;
  }

  const existing = inflight.get(key);
  if (existing !== undefined) return existing;

  const promise = getTenantActivityPage({
    db: args.db,
    tenantId: args.tenantId,
    limit: args.limit,
  })
    .then((page) => {
      cache.set(key, { page, storedAt: clock() });
      return page;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}
