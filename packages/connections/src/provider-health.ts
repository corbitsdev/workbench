// App-level provider health (CL-6092): a tenant-scoped, in-process signal
// that a provider's connection needs attention, fed by two write paths —
// a connect-time credential test failure (`routes.ts`'s `/complete` and
// `/credential/test` handlers) and a RUNTIME classified inference failure
// (the chat orchestrator, through the narrow `ProviderHealthPort` below).
//
// Deliberately in-memory and process-lifetime only, not a DB table: this
// is a UI nudge ("go check this connection"), not an audit trail, and it
// self-heals the moment a person re-tests the credential successfully —
// nothing here needs to survive a hub restart. `resolveOne` in
// `plugins.ts` already derives a coarser `needs_attention` from the
// credential row's own persisted `status` column; this store adds the
// finer-grained, human-readable *reason* a runtime inference failure
// carries, which that column never captures (it only ever moves to
// `"error"`/`"expired"`, never a why).
//
// Conservative by construction: `report` is the only way to mark a
// provider unhealthy, and `clear` (called only after a *passing*
// credential re-test) is the only way to clear it. Nothing here ever
// marks a provider healthy from a reply's prose — see
// `isClassifiedInferenceFailure` below, which gates what the orchestrator
// is even allowed to report in the first place.

/** The two `InferenceError` categories (`@intx/types/runtime`) worth
 * surfacing as "go fix your connection": a bad/revoked key or an
 * exhausted quota. Every other category (`context_overflow`, `retryable`,
 * `fatal`, `aborted`, `timeout`, `protocol_mismatch`) is either not a
 * connection problem or not durable enough to guide someone to Plugins
 * over — those turns already show their own error bubble in chat and
 * need no health signal. */
export type ClassifiedInferenceFailureCategory =
  | "credential_failure"
  | "quota_exhausted";

const CLASSIFIED_CATEGORIES: ReadonlySet<string> = new Set([
  "credential_failure",
  "quota_exhausted",
] satisfies ClassifiedInferenceFailureCategory[]);

export function isClassifiedInferenceFailure(
  category: string,
): category is ClassifiedInferenceFailureCategory {
  return CLASSIFIED_CATEGORIES.has(category);
}

export type ProviderHealthRecord = {
  readonly status: "needs_attention";
  readonly reason: string;
  readonly at: string;
};

export type ProviderHealthStore = {
  /** Marks `provider` unhealthy for `tenantId`, overwriting any prior
   * record (a newer failure's reason/time always wins). */
  report(tenantId: string, provider: string, reason: string): void;
  /** Clears a provider's unhealthy record — call only after a passing
   * credential test, never from a reply's prose. A no-op when the
   * provider was not marked unhealthy. */
  clear(tenantId: string, provider: string): void;
  get(tenantId: string, provider: string): ProviderHealthRecord | undefined;
  /** Every provider currently marked unhealthy for `tenantId`, keyed by
   * provider id. */
  listForTenant(
    tenantId: string,
  ): Readonly<Record<string, ProviderHealthRecord>>;
};

export function createProviderHealthStore(
  now: () => Date = () => new Date(),
): ProviderHealthStore {
  const byTenant = new Map<string, Map<string, ProviderHealthRecord>>();

  function tenantMap(tenantId: string): Map<string, ProviderHealthRecord> {
    let existing = byTenant.get(tenantId);
    if (existing === undefined) {
      existing = new Map();
      byTenant.set(tenantId, existing);
    }
    return existing;
  }

  return {
    report(tenantId, provider, reason) {
      tenantMap(tenantId).set(provider, {
        status: "needs_attention",
        reason,
        at: now().toISOString(),
      });
    },
    clear(tenantId, provider) {
      byTenant.get(tenantId)?.delete(provider);
    },
    get(tenantId, provider) {
      return byTenant.get(tenantId)?.get(provider);
    },
    listForTenant(tenantId) {
      const map = byTenant.get(tenantId);
      if (map === undefined) return {};
      return Object.fromEntries(map);
    },
  };
}

/** The narrow seam a chat orchestrator reports a classified runtime
 * inference failure through — never given the full store, only the one
 * write it needs. `apps/hub` wires this to a shared `ProviderHealthStore`
 * instance so the same record a `GET /provider-health` read serves is the
 * one a turn's classified failure just wrote. */
export type ProviderHealthPort = {
  reportInferenceFailure(args: {
    tenantId: string;
    provider: string;
    reason: string;
  }): void;
};

export function createProviderHealthPort(
  store: ProviderHealthStore,
): ProviderHealthPort {
  return {
    reportInferenceFailure({ tenantId, provider, reason }) {
      store.report(tenantId, provider, reason);
    },
  };
}

/** `GET /provider-health`'s response shape — the browser-safe read the
 * shell banner polls. `connectedProviderCount` is absent (not zero) when
 * the hub has no lister wired, so a caller never mistakes "unknown" for
 * "nothing connected" — see `routes.ts`'s own doc on the dep this backs. */
export type ProviderHealthSnapshot = {
  readonly providers: Readonly<Record<string, ProviderHealthRecord>>;
  readonly connectedProviderCount?: number;
};

/** The browser-safe client for `GET /provider-health` (CL-6092) — same
 * shape as `plugins.ts`'s own tenant-scoped fetch, reused by
 * `apps/web`'s shell banner rather than each caller building the path
 * itself. */
export async function fetchProviderHealth(
  tenantId: string,
): Promise<ProviderHealthSnapshot> {
  const response = await fetch(
    `/api/tenants/${tenantId}/connections/provider-health`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Failed to load provider health (${response.status})`);
  }
  return (await response.json()) as ProviderHealthSnapshot;
}
