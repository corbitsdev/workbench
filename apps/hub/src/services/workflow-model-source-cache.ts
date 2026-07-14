import type { InferenceSource } from "@intx/types/runtime";
import { LLM_DEFAULT_MODEL } from "@workbench/agents";

import { getConfig } from "../config";
import { createTtlMemo } from "../lib/ttl-memo";

// Model-source catalog cache (CL-2760). `resolveWorkflowDeploySource` resolves
// the tenant's inference sources — including a per-extra-model DB round-trip loop
// — on every provision AND every re-establish (the CL-2756 re-establish path
// sits on top of it too). The resolution is a pure function of the tenant and
// the declared-model set, and the operator catalog changes infrequently, so a
// short in-process TTL memo collapses a burst of run-starts for the same
// (tenant, model-set) onto ONE resolution.
//
// Scope kept deliberately correct:
//   - The key is `${tenantId}:${sorted declared models}` — a cached chain can
//     never cross the tenant boundary, and a different declared-model set always
//     re-resolves.
//   - The TTL is short (config-driven, ~45s default) so a catalog change is
//     picked up within the window rather than masked.
//   - Inflight de-dup: concurrent callers for the same key await one resolution.
//
// In-process only, mirroring `tenant-activity-cache.ts` and the models.dev
// pricing TTL — the hub has no redis.

const memo = createTtlMemo<InferenceSource[]>();

/** Test-only: clears the workflow model-source cache. */
export function resetWorkflowModelSourceCache(): void {
  memo.reset();
}

function cacheKey(
  tenantId: string,
  extraModels: readonly string[],
  keyExtra?: string,
): string {
  const models = [LLM_DEFAULT_MODEL, ...extraModels].sort();
  const base = `${tenantId}:${models.join(",")}`;
  return keyExtra ? `${base}:${keyExtra}` : base;
}

// Memoize the catalog-resolved source chain (before any per-step maxTokens is
// lifted — that step is a cheap pure map the caller applies to a copy). `resolve`
// is the uncached DB resolver injected by the caller.
export async function getCachedCatalogSources(args: {
  tenantId: string;
  extraModels: readonly string[];
  resolve: () => Promise<InferenceSource[]>;
  // Optional discriminator folded into the key when the resolution depends on
  // more than the (tenant, model-set) — e.g. an agent definition's per-model
  // required capabilities / creator provider preferences (CL-2804). Two
  // resolutions that would return different sources for the same model set MUST
  // pass different keyExtra, or a cached chain leaks across them.
  keyExtra?: string;
  ttlMs?: number;
  now?: () => number;
}): Promise<InferenceSource[]> {
  return memo.get({
    key: cacheKey(args.tenantId, args.extraModels, args.keyExtra),
    ttlMs: args.ttlMs ?? getConfig().workflowDeploy.modelSourceCacheTtlMs,
    now: args.now,
    resolve: args.resolve,
  });
}
