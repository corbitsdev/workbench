import {
  EMPTY_POLICY,
  type BenchModelPolicy,
  type BenchModelPolicyPatch,
} from "./policy";

export type BenchModelPolicyStore = {
  /** The bench's policy, or EMPTY_POLICY when it has never set one. */
  getPolicy(tenantId: string): Promise<BenchModelPolicy>;
  /** Applies only the fields present in `patch` and returns the result. */
  patchPolicy(
    tenantId: string,
    patch: BenchModelPolicyPatch,
  ): Promise<BenchModelPolicy>;
};

export function applyPolicyPatch(
  current: BenchModelPolicy,
  patch: BenchModelPolicyPatch,
): BenchModelPolicy {
  return {
    allow: patch.allow ?? current.allow,
    deny: patch.deny ?? current.deny,
    maxInputUsdPerMTok:
      patch.maxInputUsdPerMTok === undefined
        ? current.maxInputUsdPerMTok
        : patch.maxInputUsdPerMTok,
    maxOutputUsdPerMTok:
      patch.maxOutputUsdPerMTok === undefined
        ? current.maxOutputUsdPerMTok
        : patch.maxOutputUsdPerMTok,
    ceilingIsHard: patch.ceilingIsHard ?? current.ceilingIsHard,
    conceptCeilings:
      patch.conceptCeilings === undefined
        ? current.conceptCeilings
        : normalizeConceptCeilings(patch.conceptCeilings),
    providerPreference:
      patch.providerPreference === undefined
        ? current.providerPreference
        : patch.providerPreference,
  };
}

function normalizeConceptCeilings(
  ceilings: Record<
    string,
    { maxInputUsdPerMTok?: number | null; maxOutputUsdPerMTok?: number | null }
  >,
): Record<
  string,
  { maxInputUsdPerMTok: number | null; maxOutputUsdPerMTok: number | null }
> {
  const normalized: Record<
    string,
    { maxInputUsdPerMTok: number | null; maxOutputUsdPerMTok: number | null }
  > = {};
  for (const [conceptId, ceiling] of Object.entries(ceilings)) {
    normalized[conceptId] = {
      maxInputUsdPerMTok: ceiling.maxInputUsdPerMTok ?? null,
      maxOutputUsdPerMTok: ceiling.maxOutputUsdPerMTok ?? null,
    };
  }
  return normalized;
}

/** In-memory store for unit tests and local smoke; production wiring uses
 * the drizzle-backed implementation behind the same interface. */
export function createMemoryBenchModelPolicyStore(): BenchModelPolicyStore {
  const rows = new Map<string, BenchModelPolicy>();

  return {
    async getPolicy(tenantId) {
      return rows.get(tenantId) ?? EMPTY_POLICY;
    },
    async patchPolicy(tenantId, patch) {
      const merged = applyPolicyPatch(
        rows.get(tenantId) ?? EMPTY_POLICY,
        patch,
      );
      rows.set(tenantId, merged);
      return merged;
    },
  };
}
