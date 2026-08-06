// Unit gates for scripts/db-setup.ts against a real Postgres: the
// wiring this repo owns — shipped-migration discovery out of the
// vendored @intx/db, the setup ledger, idempotent re-runs, the loud
// mismatch failure with its documented reset fix, and the sidecar
// identity upsert. The migrations themselves are Interchange's to
// test; nothing here asserts on schema contents beyond the rows this
// script writes.
//
// The suite owns a uniquely-named sibling scratch database (created by
// setupDatabase on first use, dropped in teardown) so it never touches
// the developer's own database. Like the walking skeleton it skips
// without DATABASE_URL, and E2E_REQUIRED=1 turns that skip into a
// loud failure in CI.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  dbTargetFromUrl,
  ensureSidecarIdentity,
  resetSchema,
  setupDatabase,
} from "../db-setup.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const HUB_DIR = path.join(REPO_ROOT, "apps", "hub");
const VENDORED_MIGRATIONS_DIR = path.join(
  REPO_ROOT,
  "vendor",
  "intx",
  "db",
  "migrations",
);

function scratchDatabaseUrl(): string | undefined {
  const base = process.env["DATABASE_URL"];
  if (base === undefined || base === "") {
    if (process.env["E2E_REQUIRED"] === "1") {
      throw new Error(
        "E2E_REQUIRED=1 but DATABASE_URL is not set; the db-setup suite " +
          "would be skipped. Set DATABASE_URL to a reachable Postgres.",
      );
    }
    return undefined;
  }
  const url = new URL(base);
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(`DATABASE_URL names no database (empty path): ${base}`);
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  url.pathname = `/${database}_dbsetup_${suffix}`;
  return url.toString();
}

const databaseUrl = scratchDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "db-setup: DATABASE_URL is not set; suite skipped. " +
      "Set DATABASE_URL (see .env.example) to run it; " +
      "CI sets E2E_REQUIRED=1 so this skip can never pass silently there.",
  );
}

// Minimal local view of the postgres client, resolved out of the hub's
// dependency tree exactly like scripts/db-setup.ts resolves it.
interface SqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

async function connectTo(url: string, database?: string): Promise<SqlClient> {
  const resolved = Bun.resolveSync("postgres", HUB_DIR);
  const { default: postgres } = (await import(resolved)) as {
    default: (options: Record<string, unknown>) => SqlClient;
  };
  const target = dbTargetFromUrl(url);
  return postgres({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: database ?? target.database,
    max: 1,
    onnotice: () => undefined,
  });
}

async function sha256Hex(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString("hex");
}

function rowHashHex(row: Record<string, unknown> | undefined): string {
  const hash = row?.["token_hash_sha256"];
  if (!(hash instanceof Uint8Array)) {
    throw new Error(
      `expected token_hash_sha256 to be a Uint8Array, got ${typeof hash}`,
    );
  }
  return Buffer.from(hash).toString("hex");
}

describe.skipIf(databaseUrl === undefined)("db-setup", () => {
  const url = databaseUrl as string;

  // The suite owns the one expensive fresh apply; every test starts
  // from a fully migrated scratch database instead of relying on a
  // previous test's side effects.
  let freshApply: Awaited<ReturnType<typeof setupDatabase>>;

  beforeAll(async () => {
    freshApply = await setupDatabase(url);
  });

  afterAll(async () => {
    const maintenance = await connectTo(url, "postgres");
    try {
      const database = dbTargetFromUrl(url).database;
      await maintenance.unsafe(
        `DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`,
      );
    } finally {
      await maintenance.end();
    }
  });

  test("fresh database applies every vendored migration and records it", async () => {
    const shippedOnDisk = (await readdir(VENDORED_MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(shippedOnDisk.length).toBeGreaterThan(0);

    expect(freshApply.createdDatabase).toBe(true);
    expect(freshApply.action).toBe("migrated");
    expect(freshApply.migrations).toBe(shippedOnDisk.length);

    const sql = await connectTo(url);
    try {
      const rows = await sql.unsafe(
        `SELECT filename FROM "public"."workbench_setup_migration" ORDER BY filename`,
      );
      expect(rows.map((r) => String(r["filename"]))).toEqual(shippedOnDisk);
    } finally {
      await sql.end();
    }
  });

  test("re-run on a current schema reports unchanged and touches nothing", async () => {
    const first = await setupDatabase(url);
    expect(first.action).toBe("unchanged");
    const second = await setupDatabase(url);
    expect(second.action).toBe("unchanged");
    expect(second.migrations).toBe(first.migrations);
  });

  test("ensureSidecarIdentity upserts against the folded schema", async () => {
    await ensureSidecarIdentity(url, "sc_dbsetup_test", "token-one");
    const sql = await connectTo(url);
    try {
      const inserted = await sql.unsafe(
        `SELECT "url", "token_hash_sha256" FROM "sidecar" WHERE "id" = $1`,
        ["sc_dbsetup_test"],
      );
      expect(inserted).toHaveLength(1);
      expect(String(inserted[0]?.["url"])).toBe("ws://local-sidecar");
      expect(rowHashHex(inserted[0])).toBe(await sha256Hex("token-one"));

      // A changed token heals instead of locking the sidecar out.
      await ensureSidecarIdentity(url, "sc_dbsetup_test", "token-two");
      const updated = await sql.unsafe(
        `SELECT "token_hash_sha256" FROM "sidecar" WHERE "id" = $1`,
        ["sc_dbsetup_test"],
      );
      expect(rowHashHex(updated[0])).toBe(await sha256Hex("token-two"));
    } finally {
      await sql.end();
    }
  });

  test("a ledger that disagrees with the shipped set fails loudly; reset recovers", async () => {
    // Simulate a database set up under an older migration set (e.g. a
    // pre-fold dev database) by shortening the recorded ledger.
    const sql = await connectTo(url);
    try {
      await sql.unsafe(
        `DELETE FROM "public"."workbench_setup_migration"
         WHERE filename = (SELECT max(filename) FROM "public"."workbench_setup_migration")`,
      );
    } finally {
      await sql.end();
    }

    await expect(setupDatabase(url)).rejects.toThrow(
      /different @intx\/db migration set[\s\S]*--reset/,
    );

    // The failure names the fix; prove the fix works.
    await resetSchema(url);
    const rebuilt = await setupDatabase(url);
    expect(rebuilt.action).toBe("migrated");
  });
});
