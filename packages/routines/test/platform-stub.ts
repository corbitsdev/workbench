// This package's scratch databases hold only the `routines` schema, but
// migration 0006 backfills `definition_asset_id` from the platform's own
// `public.workflow_definition` — the one platform table these suites need
// to exist. This plants the three columns that join reads, nothing else
// (the real table is authored and migrated by `@intx/db`).
import postgres from "postgres";

export async function createPlatformWorkflowDefinitionStub(
  databaseUrl: string,
  rows: readonly {
    id: string;
    tenantId: string;
    assetId: string | null;
  }[] = [],
): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "public"."workflow_definition" (` +
        `"id" text PRIMARY KEY, "tenant_id" text NOT NULL, "asset_id" text)`,
    );
    for (const row of rows) {
      await sql.unsafe(
        `INSERT INTO "public"."workflow_definition" ("id", "tenant_id", "asset_id") VALUES ($1, $2, $3)`,
        [row.id, row.tenantId, row.assetId],
      );
    }
  } finally {
    await sql.end();
  }
}
