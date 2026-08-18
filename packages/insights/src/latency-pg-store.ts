// Postgres-backed TurnLatencyStore against the package-owned turn_latency
// table. Created after applyInsightsMigrations on the same URL — mirrors
// pg-store.ts's shape for the same reasons (see that file's header).

import postgres from "postgres";

import type {
  InsertTurnLatencyInput,
  TurnLatencyRecord,
  TurnLatencyStore,
} from "./latency-store";

type Sql = ReturnType<typeof postgres>;

type LatencyRow = {
  id: string;
  tenant_id: string;
  session_id: string;
  message_id: string;
  message_run_id: string;
  status: string;
  received_at: Date;
  reactor_start_at: Date | null;
  inference_start_at: Date | null;
  first_token_at: Date | null;
  reply_posted_at: Date;
};

function toRecord(row: LatencyRow): TurnLatencyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    messageRunId: row.message_run_id,
    status: row.status === "failed" ? "failed" : "completed",
    receivedAt: row.received_at,
    reactorStartAt: row.reactor_start_at,
    inferenceStartAt: row.inference_start_at,
    firstTokenAt: row.first_token_at,
    replyPostedAt: row.reply_posted_at,
  };
}

/**
 * Open a TurnLatencyStore on an already-migrated Postgres URL. Caller
 * owns connection lifetime via the returned `close` handle.
 */
export function createPostgresTurnLatencyStore(databaseUrl: string): {
  store: TurnLatencyStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, {
    max: 4,
    onnotice: () => undefined,
  });

  const store: TurnLatencyStore = {
    async insertLatency(input: InsertTurnLatencyInput) {
      try {
        const rows = await sql<LatencyRow[]>`
          INSERT INTO insights.turn_latency (
            id, tenant_id, session_id, message_id, message_run_id, status,
            received_at, reactor_start_at, inference_start_at,
            first_token_at, reply_posted_at
          ) VALUES (
            ${input.id}, ${input.tenantId}, ${input.sessionId},
            ${input.messageId}, ${input.messageRunId}, ${input.status},
            ${input.receivedAt}, ${input.reactorStartAt},
            ${input.inferenceStartAt}, ${input.firstTokenAt},
            ${input.replyPostedAt}
          )
          ON CONFLICT (message_run_id) DO NOTHING
          RETURNING *
        `;
        const row = rows[0];
        return row === undefined ? null : toRecord(row);
      } catch (error) {
        if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
          return null;
        }
        throw error;
      }
    },

    async listLatencyByTenants(tenantIds, opts) {
      if (tenantIds.length === 0) return [];
      const from = opts?.from;
      const to = opts?.to;
      const rows = await sql<LatencyRow[]>`
        SELECT * FROM insights.turn_latency
        WHERE tenant_id = ANY(${[...tenantIds]})
          AND (${from ?? null}::timestamptz IS NULL OR received_at >= ${from ?? null})
          AND (${to ?? null}::timestamptz IS NULL OR received_at <= ${to ?? null})
        ORDER BY received_at ASC
      `;
      return rows.map(toRecord);
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
