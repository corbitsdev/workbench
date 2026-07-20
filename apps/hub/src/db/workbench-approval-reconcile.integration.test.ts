import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  isSupersededApprovalIndexStatement,
  reconcileWorkbenchApprovalTable,
} from "./workbench-approval-reconcile";

// CL-3932: proves the workbench↔interchange "approval" table-name collision is
// resolved on BOTH the fresh-DB and the already-migrated-DB path, that the
// collision genuinely aborts without the pre-interchange reconcile step, and
// that migration 0040's now-superseded approval-index statement is both a real
// trap (it aborts on interchange's approval) and correctly detected for skip.
//
// It drives the real interchange 0038 file and the real workbench 0011 / 0040
// statements against PGlite, so a shape change on either side surfaces here.

const wbMig = (f: string) =>
  readFileSync(join(import.meta.dir, "../../migrations", f), "utf-8");
const intxMig = (f: string) =>
  readFileSync(
    join(import.meta.dir, "../../../../interchange/packages/db/migrations", f),
    "utf-8",
  );

const interchange0038 = intxMig("0038_chilly_blacklash.sql");
const workbench0011 = wbMig("0011_approval.sql");
const workbench0070 = wbMig("0070_rename_approval_to_workbench_approval.sql");

const statementsOf = (sql: string): string[] =>
  sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

// The single approval-targeting statement from 0040 (the rest of that migration
// indexes other tables and is irrelevant here).
const approval0040IndexStmt = statementsOf(
  wbMig("0040_principal_activity_indexes.sql"),
).find((s) => s.includes("approval_tenant_principal_created_idx"));
if (approval0040IndexStmt === undefined) {
  throw new Error("could not locate the approval index statement in 0040");
}
// The workbench_approval index statement 0070 owns (must NOT be treated as
// superseded — it targets the renamed table).
const workbench0070IndexStmt = statementsOf(workbench0070).find((s) =>
  s.includes("approval_tenant_principal_created_idx"),
);

async function applyStatements(client: PGlite, sql: string): Promise<void> {
  for (const stmt of statementsOf(sql)) {
    await client.exec(stmt);
  }
}

// interchange 0038's FKs reference these; minimal stubs so the real migration
// applies. Only the referenced `id` columns matter.
async function stubReferencedTables(client: PGlite): Promise<void> {
  for (const t of ["tenant", "agent_instance", "agent", "principal"]) {
    await client.exec(`CREATE TABLE "${t}" ("id" text PRIMARY KEY);`);
  }
}

async function columnExists(
  client: PGlite,
  table: string,
  column: string,
): Promise<boolean> {
  const res = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return res.rows[0]?.exists === true;
}

describe("workbench approval reconcile — fresh DB", () => {
  it("interchange and workbench approval tables coexist after the full flow", async () => {
    const client = new PGlite();
    try {
      await stubReferencedTables(client);

      // db-setup order: reconcile (no legacy table → no-op) → interchange →
      // custom migrations. The 0040 approval-index statement is skipped by the
      // runner on a fresh DB (see the dedicated test below); 0070 creates the
      // workbench_approval table + index.
      await reconcileWorkbenchApprovalTable((sql) => client.exec(sql));
      await applyStatements(client, interchange0038);
      await applyStatements(client, workbench0011); // CREATE IF NOT EXISTS → no-op
      await applyStatements(client, workbench0070);

      // interchange owns "approval" (its shape); workbench owns "workbench_approval".
      expect(await columnExists(client, "approval", "correlation_id")).toBe(
        true,
      );
      expect(await columnExists(client, "approval", "resource")).toBe(false);
      expect(await columnExists(client, "workbench_approval", "resource")).toBe(
        true,
      );
      expect(
        await columnExists(client, "workbench_approval", "correlation_id"),
      ).toBe(false);

      // The workbench approvals route can write + read its table.
      await client.exec(
        `INSERT INTO "workbench_approval" ("tenant_id","principal_id","agent_id","resource","action")
         VALUES ('ten-1','prn-1','agt-1','notion__create_page','call')`,
      );
      const rows = await client.query<{ resource: string; status: string }>(
        `SELECT resource, status FROM "workbench_approval"`,
      );
      expect(rows.rows).toEqual([
        { resource: "notion__create_page", status: "pending" },
      ]);
    } finally {
      await client.close();
    }
  });
});

describe("workbench approval reconcile — the 0040 index trap", () => {
  it("0040's approval index aborts on interchange's approval, and is flagged superseded", async () => {
    const client = new PGlite();
    try {
      await stubReferencedTables(client);
      await applyStatements(client, interchange0038);

      // The trap: interchange's approval has no principal_id, and Postgres
      // validates index columns before the IF NOT EXISTS name check.
      await expect(client.exec(approval0040IndexStmt)).rejects.toThrow(
        /principal_id|does not exist/i,
      );
    } finally {
      await client.close();
    }

    // The runner uses this predicate to skip exactly that statement.
    expect(isSupersededApprovalIndexStatement(approval0040IndexStmt)).toBe(
      true,
    );
    // …but must NOT skip 0070's index on the renamed table.
    expect(workbench0070IndexStmt).toBeDefined();
    expect(
      isSupersededApprovalIndexStatement(workbench0070IndexStmt as string),
    ).toBe(false);
  });
});

describe("workbench approval reconcile — already-migrated DB", () => {
  it("renames the legacy table (seed row survives) and interchange 0038 then succeeds", async () => {
    const client = new PGlite();
    try {
      await stubReferencedTables(client);

      // Simulate a deployed DB: the workbench approval table + its 0040 index +
      // a live row already exist. The index applies here because the workbench
      // approval HAS principal_id.
      await applyStatements(client, workbench0011);
      await client.exec(approval0040IndexStmt);
      await client.exec(
        `INSERT INTO "approval" ("tenant_id","principal_id","agent_id","resource","action","status")
         VALUES ('ten-1','prn-legacy','agt-1','slack__post','call','pending')`,
      );

      // New deploy flow: reconcile renames it, interchange 0038 then succeeds,
      // 0070 no-ops (table already exists as workbench_approval).
      await reconcileWorkbenchApprovalTable((sql) => client.exec(sql));
      await applyStatements(client, interchange0038);
      await applyStatements(client, workbench0070);

      // The seed row survived the rename into workbench_approval.
      const rows = await client.query<{
        principal_id: string;
        resource: string;
      }>(`SELECT principal_id, resource FROM "workbench_approval"`);
      expect(rows.rows).toEqual([
        { principal_id: "prn-legacy", resource: "slack__post" },
      ]);
      // interchange's approval exists and is its own (empty) table.
      expect(await columnExists(client, "approval", "correlation_id")).toBe(
        true,
      );
      const intx = await client.query(`SELECT * FROM "approval"`);
      expect(intx.rows).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("workbench approval reconcile — the collision it prevents", () => {
  it("WITHOUT the reconcile step, interchange 0038 aborts with 'already exists'", async () => {
    const client = new PGlite();
    try {
      await stubReferencedTables(client);
      await applyStatements(client, workbench0011);

      // No reconcile: interchange's bare CREATE TABLE "approval" collides.
      await expect(applyStatements(client, interchange0038)).rejects.toThrow(
        /already exists/i,
      );
    } finally {
      await client.close();
    }
  });
});
