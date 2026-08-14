export type BenchSettings = {
  readonly tenantId: string;
  readonly purpose: string | null;
  readonly type: string | null;
  readonly updatedAt: Date;
};

export type BenchSettingsPatch = {
  readonly purpose?: string;
  readonly type?: string;
};

const emptyBenchSettings = (tenantId: string): BenchSettings => ({
  tenantId,
  purpose: null,
  type: null,
  updatedAt: new Date(0),
});

export type BenchSettingsStore = {
  /** Returns the bench's stored purpose/type, or the null-valued default
   * if no row exists yet — a bench with nothing set is not an error. */
  getBenchSettings(tenantId: string): Promise<BenchSettings>;
  /**
   * Upserts `patch` into the bench's row (creating it if absent). A key
   * omitted from `patch` leaves the existing stored value untouched;
   * there is no way to clear a key back to null through this call —
   * only to set it.
   */
  patchBenchSettings(
    tenantId: string,
    patch: BenchSettingsPatch,
  ): Promise<BenchSettings>;
};

/**
 * In-memory store for unit tests and local smoke. Production wiring uses a
 * Postgres-backed implementation against the same interface (see pg-store.ts).
 */
export function createMemoryBenchSettingsStore(): BenchSettingsStore {
  const rows = new Map<string, BenchSettings>();

  return {
    async getBenchSettings(tenantId) {
      return rows.get(tenantId) ?? emptyBenchSettings(tenantId);
    },
    async patchBenchSettings(tenantId, patch) {
      const existing = rows.get(tenantId) ?? emptyBenchSettings(tenantId);
      const merged: BenchSettings = {
        tenantId,
        purpose: patch.purpose ?? existing.purpose,
        type: patch.type ?? existing.type,
        updatedAt: new Date(),
      };
      rows.set(tenantId, merged);
      return merged;
    },
  };
}
