import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, isTable, Table } from 'drizzle-orm';
import * as schema from './schema';

// Guards against the class of bug where a table is added to schema.ts but no
// migration is shipped to create it (PR #99 did exactly this for
// workbench_workflows, so every deployed environment 500'd on the missing
// relation). The custom runner in scripts/db-setup.ts applies the SQL files in
// apps/hub/migrations — not the drizzle schema — so each table must have a
// CREATE TABLE there.
describe('migrations cover the schema', () => {
  const migrationsDir = join(import.meta.dir, '../../migrations');
  const migrationSql = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(migrationsDir, f), 'utf-8'))
    .join('\n');

  const tableNames = Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table as Table));

  it('has at least one table defined', () => {
    expect(tableNames.length).toBeGreaterThan(0);
  });

  it.each(tableNames)('creates table "%s" in a migration', (tableName) => {
    const createPattern = new RegExp(`CREATE TABLE (IF NOT EXISTS )?"?${tableName}"?`, 'i');
    expect(migrationSql).toMatch(createPattern);
  });
});

describe('0015 scopes workbench_workflows per principal (CL-1450)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0015_workbench_workflows_per_principal.sql'),
    'utf-8'
  );

  it('adds the principal_id column', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "principal_id"/i);
  });

  it('backfills principal_id from the tenant user principal', () => {
    // Maps each existing row to its tenant's user principal (unambiguous today).
    expect(sql).toMatch(/UPDATE "workbench_workflows"/i);
    expect(sql).toMatch(/FROM "principal" p/i);
    expect(sql).toMatch(/p\.tenant_id = ew\.tenant_id/i);
    expect(sql).toMatch(/p\.kind = 'user'/i);
  });

  it('makes principal_id NOT NULL and swaps the unique key to include it', () => {
    expect(sql).toMatch(/ALTER COLUMN "principal_id" SET NOT NULL/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS "workbench_workflows_tenant_kind_uniq"/i);
    expect(sql).toMatch(
      /ADD CONSTRAINT "workbench_workflows_tenant_principal_kind_uniq"\s+UNIQUE \("tenant_id", "principal_id", "kind"\)/i
    );
  });
});

describe('0016 creates member_agent_instance (CL-1532)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0016_member_agent_instance.sql'),
    'utf-8'
  );

  it('creates the table with the expected columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "member_agent_instance"/i);
    for (const col of [
      'id',
      'tenant_id',
      'member_principal_id',
      'template_key',
      'agent_id',
      'instance_id',
      'created_at',
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it('adds the (tenant, member, template) unique constraint', () => {
    expect(sql).toMatch(
      /ADD CONSTRAINT "member_agent_instance_tenant_member_template_uniq"\s+UNIQUE \("tenant_id", "member_principal_id", "template_key"\)/i
    );
  });
});

describe('0020 creates upload (CL-1961)', () => {
  const sql = readFileSync(join(import.meta.dir, '../../migrations/0020_upload.sql'), 'utf-8');

  it('creates the table with the expected columns', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "upload"/i);
    for (const col of [
      'id',
      'tenant_id',
      'principal_id',
      'filename',
      'mime_type',
      'content',
      'size',
      'created_at',
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it('stores the file body as bytea', () => {
    expect(sql).toMatch(/"content"\s+"?bytea"?/i);
  });
});

describe('0018 drops member_agent_instance unique constraint (CL-1558)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0018_drop_member_agent_instance_uniq.sql'),
    'utf-8'
  );

  it('drops the (tenant, member, template) unique constraint', () => {
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS "member_agent_instance_tenant_member_template_uniq"/i
    );
  });
});

describe('0021 adds owner_principal_id to artifact (CL-2035)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0021_artifact_owner_principal_id.sql'),
    'utf-8'
  );

  it('adds the owner_principal_id column', () => {
    expect(sql).toMatch(/ALTER TABLE "artifact"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "owner_principal_id"/i);
  });

  it('keeps the column nullable (no NOT NULL or default)', () => {
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });
});

describe('0023 makes artifact.session_id nullable (CL-1679)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0023_artifact_session_nullable.sql'),
    'utf-8'
  );

  it('drops not null on session_id', () => {
    expect(sql).toMatch(/ALTER TABLE "artifact"/i);
    expect(sql).toMatch(/ALTER COLUMN "session_id" DROP NOT NULL/i);
  });
});

describe('0029 creates output_feedback (CL-1993)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0029_output_feedback.sql'),
    'utf-8'
  );

  it('creates the table with the expected columns', () => {
    expect(sql).toMatch(/CREATE TABLE (IF NOT EXISTS )?"?output_feedback"?/i);
    for (const col of [
      'id',
      'tenant_id',
      'principal_id',
      'instance_id',
      'subject_kind',
      'subject_id',
      'rating',
      'created_at',
      'updated_at',
    ]) {
      expect(sql).toMatch(new RegExp(`"${col}"`));
    }
  });

  it('enforces rating values at the DB level', () => {
    expect(sql).toMatch(/CHECK \(rating IN \(1, -1\)\)/i);
  });

  it('adds the (principal, subject_id, subject_kind) unique constraint', () => {
    expect(sql).toMatch(
      /CONSTRAINT "output_feedback_principal_subject_uniq" UNIQUE \("principal_id", "subject_id", "subject_kind"\)/i
    );
  });

  it('creates an index on (subject_kind, subject_id)', () => {
    expect(sql).toMatch(/CREATE INDEX (IF NOT EXISTS )?"?output_feedback_subject_idx"?/i);
    expect(sql).toMatch(/"subject_kind", "subject_id"/i);
  });
});

describe('0031 adds meta to workflow_run (CL-2321)', () => {
  const sql = readFileSync(
    join(import.meta.dir, '../../migrations/0031_workflow_run_meta.sql'),
    'utf-8'
  );

  it('adds a nullable meta column', () => {
    expect(sql).toMatch(/ALTER TABLE "workflow_run"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "meta" jsonb/i);
  });

  it('keeps the column nullable (no NOT NULL, no default)', () => {
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });
});
