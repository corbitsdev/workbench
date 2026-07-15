/**
 * Read-only Postgres checks for Insights model rollups.
 *
 * Local psql cannot use postgres.railway.internal — pull the public proxy URL
 * from the Postgres service and optionally merge hub/admin vars from env files:
 *
 *   railway run -e corbits-workbench-staging -s Postgres -- \
 *     bun --env-file=.env.staging scripts/analytics-models-readonly.ts staging
 *
 *   railway run -e corbits-workbench-production -s Postgres -- \
 *     bun --env-file=.env.production scripts/analytics-models-readonly.ts production
 *
 * Rollup/event query sections aggregate across all tenants (no tenant_id filter).
 * Use on trusted operator machines only; filter by tenant_id in ad-hoc SQL for one tenant.
 */
import { spawnSync } from "node:child_process";

function resolveDatabaseUrl(): string {
  const pub = process.env.DATABASE_PUBLIC_URL;
  if (pub !== undefined && pub !== "" && !pub.includes("railway.internal")) {
    return pub;
  }
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== "" && !url.includes("railway.internal")) {
    return url;
  }
  throw new Error(
    "No reachable DATABASE URL. Run via: railway run -e <env> -s Postgres -- bun --env-file=.env.<env> scripts/analytics-models-readonly.ts",
  );
}

const databaseUrl = resolveDatabaseUrl();

const label = process.argv[2] ?? "db";

const queries: { title: string; sql: string }[] = [
  {
    title: "tenants",
    sql: `SELECT id, name, slug FROM tenant ORDER BY name LIMIT 20;`,
  },
  {
    title: "per_model_rollups_30d",
    sql: `
SELECT
  model,
  SUM(turn_count) AS turns,
  SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS total_tokens
FROM analytics_rollup_daily
WHERE bucket_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY model
ORDER BY total_tokens DESC NULLS LAST, turns DESC NULLS LAST
LIMIT 30;`,
  },
  {
    title: "token_only_named_models_30d",
    sql: `
SELECT
  model,
  SUM(turn_count) AS turns,
  SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) AS total_tokens
FROM analytics_rollup_daily
WHERE bucket_date >= CURRENT_DATE - INTERVAL '30 days'
  AND model IS NOT NULL AND TRIM(model) <> ''
GROUP BY model
HAVING SUM(turn_count) = 0
   AND SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens + thinking_tokens) > 0
ORDER BY total_tokens DESC
LIMIT 30;`,
  },
  {
    title: "inference_done_by_model_30d",
    sql: `
SELECT
  metadata->>'model' AS model,
  COUNT(*) AS events
FROM analytics_event
WHERE event_type = 'inference_done'
  AND created_at >= NOW() - INTERVAL '30 days'
GROUP BY metadata->>'model'
ORDER BY events DESC
LIMIT 30;`,
  },
];

function runQuery(title: string, sql: string): void {
  const wrapped = `SET default_transaction_read_only = on;\n${sql.trim()}`;
  console.log(`\n=== ${label} :: ${title} ===\n`);
  const result = spawnSync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", wrapped],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PGOPTIONS: "-c default_transaction_read_only=on",
      },
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `psql failed for ${title} (exit ${result.status ?? "unknown"})`,
    );
  }
}

for (const q of queries) {
  runQuery(q.title, q.sql);
}