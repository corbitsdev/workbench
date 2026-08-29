// WORKBENCH DELTA (see VENDORED.md): migration 0088 rewrites the retired
// `onBodyFailure: "continue"` literal to upstream's `"tolerate"` inside
// frozen wire projections. Exercised against a scratch table carrying the
// column the statement touches. DB-gated: skipped when DATABASE_URL is unset.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = databaseUrl === "" ? describe.skip : describe;

const MIGRATION = path.resolve(
  import.meta.dir,
  "..",
  "migrations",
  "0088_workflow_definition_version_tolerate_body_failure.sql",
);

describeIfDb("0088 rewrites onBodyFailure continue -> tolerate", () => {
  const schema = `tolerate_test_${Date.now().toString(36)}`;
  const parsed = new URL(databaseUrl);
  const sql = postgres({
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username) || userInfo().username,
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
    max: 1,
    onnotice: () => undefined,
    connection: { search_path: `"${schema}"` },
  });
  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.end();
  });

  test("rewrites the literal at any depth and leaves other rows untouched", async () => {
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await sql.unsafe(
      `CREATE TABLE "workflow_definition_version" (id text PRIMARY KEY, wire_projection jsonb)`,
    );
    const nested = {
      steps: {
        section: {
          kind: "onTrigger",
          onBodyFailure: "continue",
          body: {
            inline: {
              steps: { inner: { kind: "onTrigger", onBodyFailure: "continue" } },
            },
          },
        },
      },
    };
    const untouched = { steps: { s: { kind: "onTrigger", onBodyFailure: "end" } } };
    await sql`INSERT INTO "workflow_definition_version" VALUES
      ('a', ${sql.json(nested)}), ('b', ${sql.json(untouched)}), ('c', NULL)`;

    for (const statement of readFileSync(MIGRATION, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await sql.unsafe(statement);
    }

    const rows = await sql<{ id: string; wire_projection: unknown }[]>`
      SELECT id, wire_projection FROM "workflow_definition_version" ORDER BY id`;
    expect(JSON.stringify(rows[0]!.wire_projection)).not.toContain("continue");
    expect(rows[0]!.wire_projection).toEqual(
      JSON.parse(JSON.stringify(nested).replaceAll('"continue"', '"tolerate"')),
    );
    expect(rows[1]!.wire_projection).toEqual(untouched);
    expect(rows[2]!.wire_projection).toBeNull();
  });
});
