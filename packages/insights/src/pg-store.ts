// Postgres-backed UsageStore against the package-owned usage_turn and
// model_price tables. Created after applyInsightsMigrations on the same URL.

import postgres from "postgres";

import type { TokenClasses, TokenRates } from "./pricing";
import type {
  InsertUsageInput,
  ModelPriceRecord,
  UsageStore,
  UsageTurnRecord,
} from "./store";

type Sql = ReturnType<typeof postgres>;

type UsageRow = {
  id: string;
  tenant_id: string;
  session_id: string;
  turn_id: string;
  provider: string | null;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  reported_cost_usd: string | number | null;
  recorded_at: Date;
};

function finiteNumberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function tokensFromRow(row: {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
}): TokenClasses {
  return {
    input: row.input_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    output: row.output_tokens,
    thinking: row.thinking_tokens,
  };
}

function ratesFromRow(row: {
  input_per_m_tok: string | number | null;
  output_per_m_tok: string | number | null;
  cache_read_per_m_tok: string | number | null;
  cache_write_per_m_tok: string | number | null;
  thinking_per_m_tok: string | number | null;
}): TokenRates {
  return {
    inputPerMTok: finiteNumberOrNull(row.input_per_m_tok),
    outputPerMTok: finiteNumberOrNull(row.output_per_m_tok),
    cacheReadPerMTok: finiteNumberOrNull(row.cache_read_per_m_tok),
    cacheWritePerMTok: finiteNumberOrNull(row.cache_write_per_m_tok),
    thinkingPerMTok: finiteNumberOrNull(row.thinking_per_m_tok),
  };
}

function usageFromRow(row: UsageRow): UsageTurnRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    provider: row.provider,
    model: row.model,
    tokens: tokensFromRow(row),
    reportedCostUsd: finiteNumberOrNull(row.reported_cost_usd),
    recordedAt: row.recorded_at,
  };
}

/**
 * Open a UsageStore on an already-migrated Postgres URL. Caller owns
 * connection lifetime via the returned `close` handle.
 */
export function createPostgresUsageStore(databaseUrl: string): {
  store: UsageStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
  });

  const store: UsageStore = {
    async insertUsage(input: InsertUsageInput) {
      const recordedAt = input.recordedAt ?? new Date();
      try {
        const rows = await sql<UsageRow[]>`
          INSERT INTO insights.usage_turn (
            id, tenant_id, session_id, turn_id, provider, model,
            input_tokens, cache_read_tokens, cache_write_tokens,
            output_tokens, thinking_tokens, reported_cost_usd, recorded_at
          ) VALUES (
            ${input.id}, ${input.tenantId}, ${input.sessionId}, ${input.turnId},
            ${input.provider ?? null}, ${input.model},
            ${input.tokens.input}, ${input.tokens.cacheRead},
            ${input.tokens.cacheWrite}, ${input.tokens.output},
            ${input.tokens.thinking}, ${input.reportedCostUsd ?? null}, ${recordedAt}
          )
          ON CONFLICT (turn_id) DO NOTHING
          RETURNING *
        `;
        const row = rows[0];
        if (row === undefined) return null;
        return usageFromRow(row);
      } catch (error) {
        // Unique race on turn_id that ON CONFLICT missed (rare): treat as no-op.
        if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    },

    async listUsageByTenants(tenantIds, opts) {
      if (tenantIds.length === 0) return [];
      const from = opts?.from;
      const to = opts?.to;
      const rows = await sql<UsageRow[]>`
        SELECT * FROM insights.usage_turn
        WHERE tenant_id = ANY(${[...tenantIds]})
          AND (${from ?? null}::timestamptz IS NULL OR recorded_at >= ${from ?? null})
          AND (${to ?? null}::timestamptz IS NULL OR recorded_at <= ${to ?? null})
        ORDER BY recorded_at ASC
      `;
      return rows.map(usageFromRow);
    },

    async getPrice(model) {
      const rows = await sql<
        {
          model: string;
          input_per_m_tok: string | number | null;
          output_per_m_tok: string | number | null;
          cache_read_per_m_tok: string | number | null;
          cache_write_per_m_tok: string | number | null;
          thinking_per_m_tok: string | number | null;
        }[]
      >`
        SELECT * FROM insights.model_price WHERE model = ${model} LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      return { model: row.model, rates: ratesFromRow(row) };
    },

    async listPrices() {
      const rows = await sql<
        {
          model: string;
          input_per_m_tok: string | number | null;
          output_per_m_tok: string | number | null;
          cache_read_per_m_tok: string | number | null;
          cache_write_per_m_tok: string | number | null;
          thinking_per_m_tok: string | number | null;
        }[]
      >`
        SELECT * FROM insights.model_price ORDER BY model ASC
      `;
      return rows.map((row): ModelPriceRecord => ({
        model: row.model,
        rates: ratesFromRow(row),
      }));
    },

    async upsertPrice(price) {
      const r = price.rates;
      await sql`
        INSERT INTO insights.model_price (
          model, input_per_m_tok, output_per_m_tok,
          cache_read_per_m_tok, cache_write_per_m_tok, thinking_per_m_tok
        ) VALUES (
          ${price.model},
          ${r.inputPerMTok}, ${r.outputPerMTok},
          ${r.cacheReadPerMTok}, ${r.cacheWritePerMTok}, ${r.thinkingPerMTok}
        )
        ON CONFLICT (model) DO UPDATE SET
          input_per_m_tok = EXCLUDED.input_per_m_tok,
          output_per_m_tok = EXCLUDED.output_per_m_tok,
          cache_read_per_m_tok = EXCLUDED.cache_read_per_m_tok,
          cache_write_per_m_tok = EXCLUDED.cache_write_per_m_tok,
          thinking_per_m_tok = EXCLUDED.thinking_per_m_tok
      `;
      return price;
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
