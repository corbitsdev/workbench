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
