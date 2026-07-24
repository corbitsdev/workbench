import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { generateKeyPair } from "@intx/crypto";
import {
  createAgentRepoStore,
  createAssetService,
  skillDraftAuthorize,
  skillDraftKindHandler,
} from "@workbench/hub-sessions";
import { schema } from "../src/db";
import type { HubDb } from "../src/db";
import {
  runMigration,
  statusColumnExists,
  type RawSql,
} from "./migrate-skill-drafts-to-assets";

// Proves the fix for CL-4432: the pre-fix script read `status` through the
// Drizzle ORM model, which no longer maps that column, so its filter was
// always false and it silently migrated zero rows regardless of what was in
// the database. These tests drive real Postgres (PGlite) rows through the
// raw-SQL read path and a real git-backed AssetService/AgentRepoStore, so a
// regression back to the ORM-filter bug fails them.

function makeRawSql(client: PGlite): RawSql {
  return {
    query: async <T>(text: string, params?: unknown[]) => {
      const result = await client.query<T>(text, params as unknown[]);
      return result.rows;
    },
  };
}

async function countArtifactRows(client: PGlite, id: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM artifact WHERE id = $1`,
    [id],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function findSkillDraftAsset(
  client: PGlite,
  tenantId: string,
  name: string,
): Promise<{ id: string } | undefined> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM asset WHERE tenant_id = $1 AND kind = 'skill-draft' AND name = $2`,
    [tenantId, name],
  );
  return result.rows[0];
}

async function makeAssetHarness(db: HubDb) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "migrate-skill-drafts-test-"),
  );
  const signingKey = await generateKeyPair();
  const agentRepoStore = createAgentRepoStore({
    dataDir,
    signingKey,
    handlers: {
      "skill-draft": {
        handler: skillDraftKindHandler,
        authorize: skillDraftAuthorize,
      },
    },
  });
  const assetService = createAssetService({
    db,
    repoStore: agentRepoStore.repoStore,
    registeredKinds: agentRepoStore.registeredKinds,
  });
  return {
    dataDir,
    assetService,
    repoStore: agentRepoStore.repoStore,
  };
}

async function seedTenant(client: PGlite, tenantId: string): Promise<void> {
  await client.query(
    `INSERT INTO tenant (id, name, slug, domain) VALUES ($1, $1, $1, $1 || '.test')
     ON CONFLICT (id) DO NOTHING`,
    [tenantId],
  );
}

async function seedPrincipal(
  client: PGlite,
  tenantId: string,
  principalId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO principal (id, tenant_id, kind, ref_id, status)
     VALUES ($1, $2, 'user', $1, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [principalId, tenantId],
  );
}

async function insertArtifact(
  client: PGlite,
  row: {
    id: string;
    tenantId: string;
    ownerPrincipalId: string;
    title: string;
    content: string;
    status: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO artifact (id, tenant_id, owner_principal_id, kind, title, content, source, status)
     VALUES ($1, $2, $3, 'skill-draft', $4, $5, '{}'::jsonb, $6)`,
    [
      row.id,
      row.tenantId,
      row.ownerPrincipalId,
      row.title,
      row.content,
      row.status,
    ],
  );
}

describe("migrate-skill-drafts-to-assets: column-absent guard", () => {
  let client: PGlite;
  let db: HubDb;

  beforeAll(async () => {
    client = new PGlite();
    const bootstrap = drizzle(client, { schema });
    const { apply } = await pushSchema(schema, bootstrap as never);
    await apply();
    db = bootstrap as unknown as HubDb;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("reports the column absent when the current schema has already dropped it", async () => {
    expect(await statusColumnExists(makeRawSql(client))).toBe(false);
  });

  it("exits cleanly with zero found/migrated when artifact.status does not exist", async () => {
    const { assetService, repoStore, dataDir } = await makeAssetHarness(db);
    try {
      const result = await runMigration(
        makeRawSql(client),
        db,
        assetService,
        repoStore,
        { dryRun: false, skipConfirm: true },
      );
      expect(result).toEqual({ columnPresent: false, found: 0, migrated: 0 });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("migrate-skill-drafts-to-assets: with artifact.status present", () => {
  let client: PGlite;
  let db: HubDb;

  beforeAll(async () => {
    client = new PGlite();
    const bootstrap = drizzle(client, { schema });
    const { apply } = await pushSchema(schema, bootstrap as never);
    await apply();
    // Simulate the pre-0079 physical column the Drizzle model no longer maps.
    await client.exec(`ALTER TABLE "artifact" ADD COLUMN "status" text;`);
    db = bootstrap as unknown as HubDb;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("statusColumnExists sees the physical column via raw SQL", async () => {
    expect(await statusColumnExists(makeRawSql(client))).toBe(true);
  });

  it("migrates a real status='draft' skill-draft row to a skill-draft asset and deletes the source row", async () => {
    const { assetService, repoStore, dataDir } = await makeAssetHarness(db);
    const tenantId = "ten-migrate-a";
    const artifactId = crypto.randomUUID();
    try {
      await seedTenant(client, tenantId);
      await seedPrincipal(client, tenantId, "prn-owner-a");
      await insertArtifact(client, {
        id: artifactId,
        tenantId,
        ownerPrincipalId: "prn-owner-a",
        title: "My Draft Skill",
        content: "# My Draft Skill\n\nbody",
        status: "draft",
      });

      const result = await runMigration(
        makeRawSql(client),
        db,
        assetService,
        repoStore,
        { dryRun: false, skipConfirm: true },
      );

      expect(result.found).toBe(1);
      expect(result.migrated).toBe(1);
      expect(await countArtifactRows(client, artifactId)).toBe(0);

      const asset = await findSkillDraftAsset(
        client,
        tenantId,
        "my-draft-skill",
      );
      expect(asset).toBeDefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not migrate a status='approved' row", async () => {
    const { assetService, repoStore, dataDir } = await makeAssetHarness(db);
    const tenantId = "ten-migrate-b";
    const artifactId = crypto.randomUUID();
    try {
      await seedTenant(client, tenantId);
      await seedPrincipal(client, tenantId, "prn-owner-b");
      await insertArtifact(client, {
        id: artifactId,
        tenantId,
        ownerPrincipalId: "prn-owner-b",
        title: "Already Approved",
        content: "# Already Approved",
        status: "approved",
      });

      const result = await runMigration(
        makeRawSql(client),
        db,
        assetService,
        repoStore,
        { dryRun: false, skipConfirm: true },
      );

      expect(result.found).toBe(0);
      expect(result.migrated).toBe(0);
      expect(await countArtifactRows(client, artifactId)).toBe(1);

      const asset = await findSkillDraftAsset(
        client,
        tenantId,
        "already-approved",
      );
      expect(asset).toBeUndefined();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not migrate a status='rejected' row", async () => {
    const { assetService, repoStore, dataDir } = await makeAssetHarness(db);
    const tenantId = "ten-migrate-c";
    const artifactId = crypto.randomUUID();
    try {
      await seedTenant(client, tenantId);
      await seedPrincipal(client, tenantId, "prn-owner-c");
      await insertArtifact(client, {
        id: artifactId,
        tenantId,
        ownerPrincipalId: "prn-owner-c",
        title: "Already Rejected",
        content: "# Already Rejected",
        status: "rejected",
      });

      const result = await runMigration(
        makeRawSql(client),
        db,
        assetService,
        repoStore,
        { dryRun: false, skipConfirm: true },
      );

      expect(result.found).toBe(0);
      expect(result.migrated).toBe(0);
      expect(await countArtifactRows(client, artifactId)).toBe(1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("migrate-skill-drafts-to-assets: fail-loud on missing tenant/owner", () => {
  let client: PGlite;
  let db: HubDb;

  beforeAll(async () => {
    client = new PGlite();
    const bootstrap = drizzle(client, { schema });
    const { apply } = await pushSchema(schema, bootstrap as never);
    await apply();
    await client.exec(`ALTER TABLE "artifact" ADD COLUMN "status" text;`);
    db = bootstrap as unknown as HubDb;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("throws instead of silently skipping a row with a null tenant_id", async () => {
    const { assetService, repoStore, dataDir } = await makeAssetHarness(db);
    const artifactId = crypto.randomUUID();
    try {
      await client.query(
        `INSERT INTO artifact (id, tenant_id, owner_principal_id, kind, title, content, source, status)
         VALUES ($1, NULL, 'prn-owner-d', 'skill-draft', 'Orphan Draft', '# Orphan', '{}'::jsonb, 'draft')`,
        [artifactId],
      );

      await expect(
        runMigration(makeRawSql(client), db, assetService, repoStore, {
          dryRun: false,
          skipConfirm: true,
        }),
      ).rejects.toThrow(/tenant_id\/owner_principal_id/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
