// DB-gated: skipped when no DATABASE_URL is reachable. Runs against
// its own scratch database.
//
// CL-7242: `reconcileDuplicateRepoGrants` is the one-time cleanup for
// duplicate `repo:<owner/name>` grants a database can already carry
// from before the `repo_review_lease` fix started preventing new
// ones. Proves it keeps exactly one grant per group (never zero,
// matching the "a repo never ends up with fewer grants than it had"
// bar), never touches an unrelated grant, and is safe to re-run.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";

import { runMigrations } from "@intx/db";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { reconcileDuplicateRepoGrants } from "./reconcile-duplicate-repo-grants";
import { dbGate } from "../../../scripts/e2e/db-gate";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_reconcile_duplicate_repo_grants_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_ID = "tnt_reconcile";
const ROLE_ID = "role_reconcile_member";

describeIfDb("reconcileDuplicateRepoGrants", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchTarget = new URL(scratchUrl);
  const scratchDatabase = scratchTarget.pathname.replace(/^\//, "");

  beforeAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
      await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
    const parsed = new URL(scratchUrl);
    await runMigrations(
      {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: scratchDatabase,
      },
      { schema: "public" },
    );
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql`INSERT INTO "tenant" (id, name, slug, domain) VALUES (${TENANT_ID}, 'Acme', 'acme-reconcile', 'acme-reconcile.example')`;
      await sql`INSERT INTO "role" (id, tenant_id, name) VALUES (${ROLE_ID}, ${TENANT_ID}, 'member')`;
    } finally {
      await sql.end();
    }
  });

  afterAll(async () => {
    const maintenanceUrl = new URL(scratchUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    } finally {
      await maintenance.end();
    }
  });

  test("keeps exactly one grant per duplicated (tenant, resource, action) and leaves other grants alone", async () => {
    const sql = postgres(scratchUrl, { max: 1, onnotice: () => undefined });
    try {
      // Two duplicate repo grants from the pre-lease race, one pair from
      // each generation of `mintRepoGrant`: the direct-insert path this
      // PR replaced wrote `'system'`-origin rows; the current
      // `mintRepoGrantViaHttp` path writes `'creator'`-origin rows.
      await sql`
        INSERT INTO "grant" (id, tenant_id, role_id, resource, action, effect, origin, created_at)
        VALUES
          ('grant_dup_1', ${TENANT_ID}, ${ROLE_ID}, 'repo:acme/widgets', 'read', 'allow', 'system', now() - interval '1 hour'),
          ('grant_dup_2', ${TENANT_ID}, ${ROLE_ID}, 'repo:acme/widgets', 'read', 'allow', 'creator', now())
      `;
      // A non-duplicated repo grant, a non-repo system grant, and a
      // repo grant with an origin this feature never writes -- none
      // should ever be touched.
      await sql`
        INSERT INTO "grant" (id, tenant_id, role_id, resource, action, effect, origin)
        VALUES
          ('grant_solo', ${TENANT_ID}, ${ROLE_ID}, 'repo:acme/gadgets', 'read', 'allow', 'creator'),
          ('grant_unrelated', ${TENANT_ID}, ${ROLE_ID}, 'workbench:room-1', 'read', 'allow', 'system'),
          ('grant_other_origin', ${TENANT_ID}, ${ROLE_ID}, 'repo:acme/gizmos', 'read', 'allow', 'role')
      `;

      const first = await reconcileDuplicateRepoGrants(scratchUrl);
      expect(first.removedIds).toEqual(["grant_dup_2"]);

      const widgetsRows = await sql`
        SELECT id FROM "grant" WHERE tenant_id = ${TENANT_ID} AND resource = 'repo:acme/widgets'
      `;
      expect(widgetsRows).toHaveLength(1);
      expect(widgetsRows[0]?.["id"]).toBe("grant_dup_1");

      const untouchedRows = await sql`
        SELECT id FROM "grant" WHERE id IN ('grant_solo', 'grant_unrelated', 'grant_other_origin')
        ORDER BY id
      `;
      expect(untouchedRows.map((r) => r["id"])).toEqual([
        "grant_other_origin",
        "grant_solo",
        "grant_unrelated",
      ]);

      // Idempotent: nothing left to remove on a second run.
      const second = await reconcileDuplicateRepoGrants(scratchUrl);
      expect(second.removedIds).toEqual([]);
    } finally {
      await sql.end();
    }
  });
});
