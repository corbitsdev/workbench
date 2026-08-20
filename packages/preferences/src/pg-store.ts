// Postgres-backed PreferencesStore against the package-owned
// user_preferences table. Created after applyPreferencesMigrations on the
// same URL. The merge itself happens in Postgres (`data || patch`) inside
// the upsert so concurrent patches from the same principal never clobber
// each other on a read-modify-write race in application code.
//
// The patch value is sent via `sql.json(...)`, not a `${...}::jsonb` cast
// on a plain string parameter — the latter reaches Postgres with the wrong
// parameter type and silently changes `||`'s behavior from an object merge
// to an array-append, observed directly against this repo's postgres.js
// version (verified with psql producing the correct merge for the same SQL
// text, isolating the bug to that parameter-binding path).
import postgres from "postgres";

import type { PreferencesStore } from "./store";

type Sql = ReturnType<typeof postgres>;

// postgres.js's jsonb column parser is not reliable under every runtime
// this repo ships on (observed returning the raw text under bun rather
// than the parsed object) — parse defensively instead of trusting the
// driver to have deserialized `data` already.
function parseJsonbData(value: unknown): Record<string, unknown> {
  if (typeof value === "string")
    return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

/**
 * Open a PreferencesStore on an already-migrated Postgres URL. Caller owns
 * connection lifetime via the returned `close` handle.
 */
export function createPostgresPreferencesStore(databaseUrl: string): {
  store: PreferencesStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
  });

  const store: PreferencesStore = {
    async getPreferences(tenantId, principalId) {
      const rows = await sql<{ data: unknown }[]>`
        SELECT data FROM preferences.user_preferences
        WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? {} : parseJsonbData(row.data);
    },

    async patchPreferences(tenantId, principalId, patch) {
      const rows = await sql<{ data: unknown }[]>`
        INSERT INTO preferences.user_preferences (tenant_id, principal_id, data, updated_at)
        VALUES (${tenantId}, ${principalId}, ${sql.json(patch as never)}, now())
        ON CONFLICT (tenant_id, principal_id) DO UPDATE SET
          data = preferences.user_preferences.data || EXCLUDED.data,
          updated_at = now()
        RETURNING data
      `;
      const row = rows[0];
      return row === undefined ? patch : parseJsonbData(row.data);
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
