import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableName, isTable, Table } from "drizzle-orm";
import * as schema from "./schema";

// Guards against the class of bug where a table is added to schema.ts but no
// migration is shipped to create it (PR #99 did exactly this for
// workbench_workflows, so every deployed environment 500'd on the missing
// relation). The custom runner in scripts/db-setup.ts applies the SQL files in
// apps/hub/migrations — not the drizzle schema — so each table must have a
// CREATE TABLE there.
describe("migrations cover the schema", () => {
  const migrationsDir = join(import.meta.dir, "../../migrations");
  const migrationSql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(migrationsDir, f), "utf-8"))
    .join("\n");

  const tableNames = Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table as Table));

  it("has at least one table defined", () => {
    expect(tableNames.length).toBeGreaterThan(0);
  });

  it.each(tableNames)('creates table "%s" in a migration', (tableName) => {
    const createPattern = new RegExp(
      `CREATE TABLE (IF NOT EXISTS )?"?${tableName}"?`,
      "i",
    );
    expect(migrationSql).toMatch(createPattern);
  });
});

// Guards against the class of bug CL-3932 fixed: an interchange pin bump adds a
// table whose name collides with a LIVE workbench table. scripts/db-setup.ts
// runs interchange migrations BEFORE the workbench ones, and interchange's
// CREATE TABLE statements have no IF NOT EXISTS — so a collision aborts the whole
// deploy on already-migrated DBs (interchange 0038's bare `CREATE TABLE
// "approval"` vs the workbench's own approval table, now renamed to
// workbench_approval). Catch the next such collision at PR time, not deploy time.
describe("no table-name collision with interchange migrations", () => {
  function createTableNames(sqlDir: string): Set<string> {
    const names = new Set<string>();
    const re = /CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_][a-z0-9_]*)"?/gi;
    for (const f of readdirSync(sqlDir).filter((n) => n.endsWith(".sql"))) {
      const sql = readFileSync(join(sqlDir, f), "utf-8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql)) !== null) {
        const name = m[1];
        if (name !== undefined) names.add(name.toLowerCase());
      }
    }
    return names;
  }

  const workbenchMigrationsDir = join(import.meta.dir, "../../migrations");
  const interchangeMigrationsDir = join(
    import.meta.dir,
    "../../../../interchange/packages/db/migrations",
  );
  const liveWorkbenchTables = new Set(
    Object.values(schema)
      .filter((v) => isTable(v))
      .map((t) => getTableName(t as Table)),
  );

  it("no live workbench schema table shares a name with an interchange migration table", () => {
    const intxTables = createTableNames(interchangeMigrationsDir);
    const collisions = [...liveWorkbenchTables].filter((t) =>
      intxTables.has(t),
    );
    expect(collisions).toEqual([]);
  });

  it("any workbench-migration table name shared with interchange is a renamed-away legacy table, never a live one", () => {
    const intxTables = createTableNames(interchangeMigrationsDir);
    const wbMigrationTables = createTableNames(workbenchMigrationsDir);
    // Historical collisions are tolerated ONLY when the workbench table has
    // since been renamed out of the live schema (e.g. legacy "approval" →
    // workbench_approval, whose 0011 CREATE is immutable history). A collision
    // on a table still present in schema.ts is a real, ship-blocking defect.
    const liveCollisions = [...wbMigrationTables].filter(
      (t) => intxTables.has(t) && liveWorkbenchTables.has(t),
    );
    expect(liveCollisions).toEqual([]);
  });
});

describe("0015 scopes workbench_workflows per principal (CL-1450)", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0015_workbench_workflows_per_principal.sql",
    ),
    "utf-8",
  );

  it("adds the principal_id column", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "principal_id"/i);
  });

  it("backfills principal_id from the tenant user principal", () => {
    // Maps each existing row to its tenant's user principal (unambiguous today).
    expect(sql).toMatch(/UPDATE "workbench_workflows"/i);
    expect(sql).toMatch(/FROM "principal" p/i);
    expect(sql).toMatch(/p\.tenant_id = ew\.tenant_id/i);
    expect(sql).toMatch(/p\.kind = 'user'/i);
  });

  it("makes principal_id NOT NULL and swaps the unique key to include it", () => {
    expect(sql).toMatch(/ALTER COLUMN "principal_id" SET NOT NULL/i);
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS "workbench_workflows_tenant_kind_uniq"/i,
    );
    expect(sql).toMatch(
      /ADD CONSTRAINT "workbench_workflows_tenant_principal_kind_uniq"\s+UNIQUE \("tenant_id", "principal_id", "kind"\)/i,
    );
  });
});

describe("0016 creates member_agent_instance (CL-1532)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0016_member_agent_instance.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "member_agent_instance"/i);
    for (const col of [
      "id",
      "tenant_id",
      "member_principal_id",
      "template_key",
      "agent_id",
      "instance_id",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("adds the (tenant, member, template) unique constraint", () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "member_agent_instance_tenant_member_template_uniq"\s+UNIQUE \("tenant_id", "member_principal_id", "template_key"\)/i,
    );
  });
});

describe("0020 creates upload (CL-1961)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0020_upload.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "upload"/i);
    for (const col of [
      "id",
      "tenant_id",
      "principal_id",
      "filename",
      "mime_type",
      "content",
      "size",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("stores the file body as bytea", () => {
    expect(sql).toMatch(/"content"\s+"?bytea"?/i);
  });
});

describe("0018 drops member_agent_instance unique constraint (CL-1558)", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0018_drop_member_agent_instance_uniq.sql",
    ),
    "utf-8",
  );

  it("drops the (tenant, member, template) unique constraint", () => {
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS "member_agent_instance_tenant_member_template_uniq"/i,
    );
  });
});

describe("0021 adds owner_principal_id to artifact (CL-2035)", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0021_artifact_owner_principal_id.sql",
    ),
    "utf-8",
  );

  it("adds the owner_principal_id column", () => {
    expect(sql).toMatch(/ALTER TABLE "artifact"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "owner_principal_id"/i);
  });

  it("keeps the column nullable (no NOT NULL or default)", () => {
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });
});

describe("0023 makes artifact.session_id nullable (CL-1679)", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0023_artifact_session_nullable.sql",
    ),
    "utf-8",
  );

  it("drops not null on session_id", () => {
    expect(sql).toMatch(/ALTER TABLE "artifact"/i);
    expect(sql).toMatch(/ALTER COLUMN "session_id" DROP NOT NULL/i);
  });
});

describe("0029 creates output_feedback (CL-1993)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0029_output_feedback.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?output_feedback"?/i);
    for (const col of [
      "id",
      "tenant_id",
      "principal_id",
      "instance_id",
      "subject_kind",
      "subject_id",
      "rating",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("enforces rating values at the DB level", () => {
    expect(sql).toMatch(/CHECK \(rating IN \(1, -1\)\)/i);
  });

  it("adds the (principal, subject_id, subject_kind) unique constraint", () => {
    expect(sql).toMatch(
      /CONSTRAINT "output_feedback_principal_subject_uniq" UNIQUE \("principal_id", "subject_id", "subject_kind"\)/i,
    );
  });

  it("creates an index on (subject_kind, subject_id)", () => {
    expect(sql).toMatch(
      /CREATE INDEX (IF NOT EXISTS )?"?output_feedback_subject_idx"?/i,
    );
    expect(sql).toMatch(/"subject_kind", "subject_id"/i);
  });
});

describe("0036 drops pain_point and artifact provenance columns (CL-2669)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0036_drop_pain_point.sql"),
    "utf-8",
  );

  it("drops the pain_point table", () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS "pain_point"/i);
  });

  it("drops artifact.session_id and artifact.pain_point_id", () => {
    expect(sql).toMatch(
      /ALTER TABLE "artifact" DROP COLUMN IF EXISTS "session_id"/i,
    );
    expect(sql).toMatch(
      /ALTER TABLE "artifact" DROP COLUMN IF EXISTS "pain_point_id"/i,
    );
  });

  it("drops pain_point from the drizzle schema too (no resurrection via the coverage guard)", () => {
    // The schema is the source of truth the migrations-cover-schema guard above
    // walks. If pain_point were still exported it would demand a CREATE TABLE,
    // contradicting this drop — so the table must be gone from schema.ts as well.
    const schemaTables = Object.values(schema)
      .filter((value) => isTable(value))
      .map((table) => getTableName(table as Table));
    expect(schemaTables).not.toContain("pain_point");
  });
});

describe("0031 adds meta to workflow_run (CL-2321)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0031_workflow_run_meta.sql"),
    "utf-8",
  );

  it("adds a nullable meta column", () => {
    expect(sql).toMatch(/ALTER TABLE "workflow_run"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "meta" jsonb/i);
  });

  it("keeps the column nullable (no NOT NULL, no default)", () => {
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });
});

describe("0041 creates workflow_run_step (CL-2727)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0041_workflow_run_step.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?workflow_run_step"?/i);
    for (const col of [
      "id",
      "run_id",
      "step_id",
      "phase",
      "attempts",
      "started_at",
      "ended_at",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("adds the (run_id, step_id) unique constraint", () => {
    expect(sql).toMatch(
      /CONSTRAINT "workflow_run_step_run_step_uniq" UNIQUE \("run_id", "step_id"\)/i,
    );
  });

  it("touches NO interchange-owned table — the per-step projection is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0040 adds principal-activity timeline indexes on workbench tables only (CL-2490)", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0040_principal_activity_indexes.sql",
    ),
    "utf-8",
  );

  it("indexes every workbench-owned direct-scoped timeline source on (tenant, principal, ts DESC)", () => {
    for (const [table, principalColumn, tsColumn] of [
      ["analytics_event", "principal_id", "occurred_at"],
      ["workflow_run_record", "principal_id", "created_at"],
      ["artifact", "principal_id", "created_at"],
      ["artifact", "owner_principal_id", "created_at"],
      ["upload", "principal_id", "created_at"],
      ["memory", "owner_principal_id", "updated_at"],
      ["approval", "principal_id", "created_at"],
      ["output_feedback", "principal_id", "created_at"],
    ] as const) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE INDEX IF NOT EXISTS "[a-z_]+" ON "${table}" \\("tenant_id", "${principalColumn}", "${tsColumn}" DESC\\)`,
          "i",
        ),
      );
    }
  });

  it("scopes artifact_version by author and keeps the tool_call index partial", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "[a-z_]+" ON "artifact_version" \("author_id", "created_at" DESC\)/i,
    );
    expect(sql).toMatch(/WHERE event_type = 'tool_call'/i);
  });

  it("touches NO interchange-owned table — we build on Interchange, never index its tables from workbench migrations", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
    ]) {
      expect(sql).not.toMatch(new RegExp(`ON "${table}"`, "i"));
    }
  });
});

describe("0046 creates principal_mailbox", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0046_principal_mailbox.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "principal_mailbox"/i);
    for (const col of [
      "id",
      "tenant_id",
      "principal_id",
      "address",
      "direction",
      "raw",
      "subject",
      "from_address",
      "created_at",
      "read_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`, "i"));
    }
  });

  it("indexes the per-principal list read path", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "principal_mailbox_principal_created_idx"\s+ON "principal_mailbox" \("tenant_id", "principal_id", "created_at"\)/i,
    );
  });

  it("touches NO interchange-owned table — the mailbox is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0050 adds message_key to principal_mailbox", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../../migrations/0050_principal_mailbox_message_key.sql",
    ),
    "utf-8",
  );

  it("adds a nullable message_key column", () => {
    expect(sql).toMatch(/ALTER TABLE "principal_mailbox"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "message_key" text/i);
    expect(sql).not.toMatch(/"message_key" text NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });

  it("dedupes keyed rows per (tenant, principal, message_key)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "principal_mailbox_message_key_uniq"\s+ON "principal_mailbox" \("tenant_id", "principal_id", "message_key"\)\s+WHERE "message_key" IS NOT NULL/i,
    );
  });

  it("touches NO interchange-owned table — the mailbox is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0047 creates scheduled_trigger", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0047_scheduled_trigger.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?scheduled_trigger"?/i);
    for (const col of [
      "id",
      "tenant_id",
      "owner_member_principal_id",
      "workflow_kind",
      "hour_utc",
      "trigger_payload",
      "enabled",
      "last_fired_day_utc",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("adds the (tenant, owner, kind) unique constraint so the seeder is idempotent", () => {
    expect(sql).toMatch(
      /CONSTRAINT "scheduled_trigger_owner_kind_uniq" UNIQUE \("tenant_id", "owner_member_principal_id", "workflow_kind"\)/i,
    );
  });

  it("touches NO interchange-owned table — the schedule store is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0048 creates workflow_trigger", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0048_workflow_trigger.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?workflow_trigger"?/i);
    for (const col of [
      "id",
      "tenant_id",
      "owner_member_principal_id",
      "workflow_kind",
      "secret_hash",
      "enabled",
      "created_at",
      "last_fired_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("never stores the plaintext secret, only its hash", () => {
    expect(sql).not.toMatch(/"secret"\s/i);
    expect(sql).toMatch(/"secret_hash" text NOT NULL/i);
  });

  it("keeps last_fired_at nullable", () => {
    expect(sql).toMatch(/"last_fired_at" timestamp\s*\n?\)/i);
  });

  it("touches NO interchange-owned table — the trigger store is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0049 creates task and task_external_ref", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0049_task.sql"),
    "utf-8",
  );

  it("creates the task table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?task"?/i);
    for (const col of [
      "id",
      "tenant_id",
      "owner_principal_id",
      "created_by_principal_id",
      "title",
      "body",
      "status",
      "source",
      "source_ref",
      "due",
      "links",
      "created_at",
      "updated_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("creates the task_external_ref table with attribution and sync columns", () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?task_external_ref"?/i);
    for (const col of [
      "task_id",
      "adapter_id",
      "external_id",
      "external_url",
      "sync_state",
      "actor_principal_id",
      "last_synced_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("adds the (task_id, adapter_id) unique constraint — the create idempotency backstop", () => {
    expect(sql).toMatch(/UNIQUE \("task_id", "adapter_id"\)/i);
  });

  it("indexes the inbox query on (tenant_id, owner_principal_id, status)", () => {
    expect(sql).toMatch(
      /"task_tenant_owner_status_idx"[\s\S]*"tenant_id", "owner_principal_id", "status"/i,
    );
  });

  it("cascades external refs to their parent task", () => {
    expect(sql).toMatch(/REFERENCES "task"\s*\("id"\)\s*ON DELETE CASCADE/i);
  });

  it("touches NO interchange-owned table — the task store is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0055 adds source_ref to artifact (CL-3577 review fix B)", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0055_artifact_source_ref.sql"),
    "utf-8",
  );

  it("adds a nullable source_ref column", () => {
    expect(sql).toMatch(/ALTER TABLE "artifact"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "source_ref" text/i);
    expect(sql).not.toMatch(/"source_ref" text NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });

  it("dedupes keyed rows per (tenant, source_ref)", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "artifact_tenant_source_ref_uniq"\s+ON "artifact" \("tenant_id", "source_ref"\)\s+WHERE "source_ref" IS NOT NULL/i,
    );
  });

  it("touches NO interchange-owned table — artifact is workbench-owned", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0059 creates mail_attachment_ref", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0059_mail_attachment_ref.sql"),
    "utf-8",
  );

  it("creates the table with the expected columns", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "mail_attachment_ref"/i);
    for (const col of [
      "id",
      "tenant_id",
      "principal_id",
      "instance_id",
      "mail_id",
      "artifact_id",
      "name",
      "mime_type",
      "size",
      "created_at",
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it("dedupes per (mail_id, artifact_id) so a resend cannot double a chip", () => {
    expect(sql).toMatch(
      /CONSTRAINT "mail_attachment_ref_mail_artifact_uniq" UNIQUE \("mail_id", "artifact_id"\)/i,
    );
  });

  it("indexes the per-instance read path", () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "mail_attachment_ref_instance_idx"\s+ON "mail_attachment_ref" \("instance_id"\)/i,
    );
  });

  it("touches NO interchange-owned table — refs key session_mail ids by value only", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});

describe("0051 adds assignee_principal_id to task", () => {
  const sql = readFileSync(
    join(import.meta.dir, "../../migrations/0051_task_assignee.sql"),
    "utf-8",
  );

  it("adds a nullable assignee_principal_id column", () => {
    expect(sql).toMatch(/ALTER TABLE "task"/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS "assignee_principal_id" text/i,
    );
    expect(sql).not.toMatch(/"assignee_principal_id" text NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });

  it("indexes the (tenant, assignee, status) read path", () => {
    expect(sql).toMatch(
      /"task_tenant_assignee_status_idx"[\s\S]*"tenant_id", "assignee_principal_id", "status"/i,
    );
  });

  it("touches NO interchange-owned table — assignment is a workbench-owned column", () => {
    for (const table of [
      "agent_session",
      "session_mail",
      "inference_turn",
      "grant",
      "credential",
      "principal",
      "tenant",
      "agent_instance",
    ]) {
      expect(sql).not.toMatch(
        new RegExp(`(ON|TABLE( IF NOT EXISTS)?) "${table}"`, "i"),
      );
    }
  });
});
