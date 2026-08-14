// Postgres-backed BenchSettingsStore against the package-owned
// bench_settings table. Created after applyBenchMigrations on the same
// URL. `purpose`/`type` are plain columns, not a jsonb bag, so the
// upsert's partial-patch semantics come from `COALESCE(EXCLUDED.col,
// existing.col)` rather than the `||` merge `@corbits/preferences` uses
// for its jsonb column: a patch key that's absent sends `null` for that
// column on the INSERT side, and COALESCE falls back to whatever the row
// already had rather than overwriting it with that null.
import postgres from "postgres";

import type {
  BenchSettings,
  BenchSettingsPatch,
  BenchSettingsStore,
} from "./store";

type Sql = ReturnType<typeof postgres>;

type BenchSettingsRow = {
  tenant_id: string;
  purpose: string | null;
  type: string | null;
  updated_at: Date | string;
};

function toBenchSettings(row: BenchSettingsRow): BenchSettings {
  return {
    tenantId: row.tenant_id,
    purpose: row.purpose,
    type: row.type,
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Open a BenchSettingsStore on an already-migrated Postgres URL. Caller owns
 * connection lifetime via the returned `close` handle.
 */
export function createPostgresBenchSettingsStore(databaseUrl: string): {
  store: BenchSettingsStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
  });

  const store: BenchSettingsStore = {
    async getBenchSettings(tenantId) {
      const rows = await sql<BenchSettingsRow[]>`
        SELECT tenant_id, purpose, type, updated_at
        FROM bench.bench_settings
        WHERE tenant_id = ${tenantId}
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined
        ? { tenantId, purpose: null, type: null, updatedAt: new Date(0) }
        : toBenchSettings(row);
    },

    async patchBenchSettings(tenantId, patch: BenchSettingsPatch) {
      const rows = await sql<BenchSettingsRow[]>`
        INSERT INTO bench.bench_settings (tenant_id, purpose, type, updated_at)
        VALUES (${tenantId}, ${patch.purpose ?? null}, ${patch.type ?? null}, now())
        ON CONFLICT (tenant_id) DO UPDATE SET
          purpose = COALESCE(EXCLUDED.purpose, bench.bench_settings.purpose),
          type = COALESCE(EXCLUDED.type, bench.bench_settings.type),
          updated_at = now()
        RETURNING tenant_id, purpose, type, updated_at
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error(
          `patchBenchSettings: upsert returned no row for ${tenantId}`,
        );
      }
      return toBenchSettings(row);
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
