// Postgres-backed EvalRunStore against the package-owned evals.run
// table. Created after applyEvalsMigrations on the same URL.
import postgres from "postgres";

import type { EvalRunResult } from "../types.ts";
import type { EvalRunRecord, EvalRunStore } from "./store.ts";

type Sql = ReturnType<typeof postgres>;

function parseJsonbSteps(value: unknown): EvalRunResult["steps"] {
  if (typeof value === "string") {
    return JSON.parse(value) as EvalRunResult["steps"];
  }
  return (value ?? []) as EvalRunResult["steps"];
}

interface RunRow {
  id: string;
  eval_name: string;
  config_name: string;
  started_at: Date;
  finished_at: Date;
  steps: unknown;
}

function toRecord(row: RunRow): EvalRunRecord {
  return {
    id: row.id,
    evalName: row.eval_name,
    configName: row.config_name,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    steps: parseJsonbSteps(row.steps),
  };
}

export function createPostgresEvalRunStore(databaseUrl: string): {
  store: EvalRunStore;
  close: () => Promise<void>;
} {
  const sql: Sql = postgres(databaseUrl, { max: 4, onnotice: () => undefined });

  const store: EvalRunStore = {
    async save(result) {
      const id = `evalrun_${crypto.randomUUID()}`;
      await sql`
        INSERT INTO evals.run
          (id, eval_name, config_name, started_at, finished_at, steps)
        VALUES (
          ${id},
          ${result.evalName},
          ${result.configName},
          ${result.startedAt},
          ${result.finishedAt},
          ${sql.json(result.steps as never)}
        )
      `;
      return id;
    },

    async recent(evalName, limit) {
      const rows = await sql<RunRow[]>`
        SELECT id, eval_name, config_name, started_at, finished_at, steps
        FROM evals.run
        WHERE eval_name = ${evalName}
        ORDER BY recorded_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toRecord);
    },

    async recentAcrossEvals(limit) {
      const rows = await sql<RunRow[]>`
        SELECT id, eval_name, config_name, started_at, finished_at, steps
        FROM evals.run
        ORDER BY recorded_at DESC
        LIMIT ${limit}
      `;
      return rows.map(toRecord);
    },

    async get(id) {
      const rows = await sql<RunRow[]>`
        SELECT id, eval_name, config_name, started_at, finished_at, steps
        FROM evals.run
        WHERE id = ${id}
        LIMIT 1
      `;
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },
  };

  return {
    store,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
