// Postgres-backed BenchModelPolicyStore against the package-owned
// bench_model_policy table. Opened after applyInferenceCatalogMigrations on
// the same URL; the caller owns connection lifetime.
//
// The patch is merged in application code rather than in SQL: a policy is a
// small set of named fields a human edits from a settings surface, not a
// forward-compatible bag, so a read-modify-write of the whole row is the
// honest shape. The read and the write run in one transaction so two
// concurrent edits cannot interleave.
import postgres from "postgres";

import { EMPTY_POLICY, type BenchModelPolicy } from "./policy";
import { applyPolicyPatch, type BenchModelPolicyStore } from "./store";

type Sql = ReturnType<typeof postgres>;

type PolicyRow = {
  allow: string[];
  deny: string[];
  max_input_usd_per_mtok: string | null;
  max_output_usd_per_mtok: string | null;
  ceiling_is_hard: boolean;
  concept_ceilings: unknown;
  provider_preference: unknown;
};

// postgres.js does not reliably deserialize jsonb under every runtime this
// repo ships on — parse defensively rather than trusting the driver.
function parseJsonb<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function toPolicy(row: PolicyRow): BenchModelPolicy {
  return {
    allow: row.allow,
    deny: row.deny,
    maxInputUsdPerMTok:
      row.max_input_usd_per_mtok === null
        ? null
        : Number(row.max_input_usd_per_mtok),
    maxOutputUsdPerMTok:
      row.max_output_usd_per_mtok === null
        ? null
        : Number(row.max_output_usd_per_mtok),
    ceilingIsHard: row.ceiling_is_hard,
    conceptCeilings: parseJsonb(row.concept_ceilings, {}),
    providerPreference: parseJsonb(row.provider_preference, null),
  };
}

export function createPostgresBenchModelPolicyStore(databaseUrl: string): {
  store: BenchModelPolicyStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined });

  const store: BenchModelPolicyStore = {
    async getPolicy(tenantId) {
      const rows = await sql<PolicyRow[]>`
        SELECT allow, deny, max_input_usd_per_mtok, max_output_usd_per_mtok,
               ceiling_is_hard, concept_ceilings, provider_preference
        FROM inference_catalog.bench_model_policy
        WHERE tenant_id = ${tenantId}
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? EMPTY_POLICY : toPolicy(row);
    },

    async patchPolicy(tenantId, patch) {
      return await sql.begin(async (tx) => {
        const rows = await tx<PolicyRow[]>`
          SELECT allow, deny, max_input_usd_per_mtok, max_output_usd_per_mtok,
                 ceiling_is_hard, concept_ceilings, provider_preference
          FROM inference_catalog.bench_model_policy
          WHERE tenant_id = ${tenantId}
          FOR UPDATE
        `;
        const row = rows[0];
        const merged = applyPolicyPatch(
          row === undefined ? EMPTY_POLICY : toPolicy(row),
          patch,
        );
        await tx`
          INSERT INTO inference_catalog.bench_model_policy
            (tenant_id, allow, deny, max_input_usd_per_mtok,
             max_output_usd_per_mtok, ceiling_is_hard, concept_ceilings,
             provider_preference, updated_at)
          VALUES (
            ${tenantId},
            ${[...merged.allow]},
            ${[...merged.deny]},
            ${merged.maxInputUsdPerMTok},
            ${merged.maxOutputUsdPerMTok},
            ${merged.ceilingIsHard},
            ${tx.json(merged.conceptCeilings as never)},
            ${merged.providerPreference === null ? null : tx.json(merged.providerPreference as never)},
            now()
          )
          ON CONFLICT (tenant_id) DO UPDATE SET
            allow = EXCLUDED.allow,
            deny = EXCLUDED.deny,
            max_input_usd_per_mtok = EXCLUDED.max_input_usd_per_mtok,
            max_output_usd_per_mtok = EXCLUDED.max_output_usd_per_mtok,
            ceiling_is_hard = EXCLUDED.ceiling_is_hard,
            concept_ceilings = EXCLUDED.concept_ceilings,
            provider_preference = EXCLUDED.provider_preference,
            updated_at = now()
        `;
        return merged;
      });
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
