// Real-stack coverage for the create → skills round-trip. The bug this
// guards against (CL-6135) only shows up through the real
// `AssetService`'s `populateAsset`, which runs
// vendor/intx/hub-sessions' `workflow-kind.ts` tree validator against
// an actual git commit — `routes.test.ts`'s hand-rolled fake
// `AssetService` never exercises that validator, so it could not have
// caught this. A definition created WITH skills used to write
// `skills.json` into the asset tree beside its definition, which that
// validator rejected. Pinned skills now live in this package's own
// `agent_directory.definition_skills` table (see
// `../src/skills-store.ts`), so the asset tree only ever carries the
// source codebase `agentDefinitionSourceTree` renders — the one shape
// the validator now accepts, the retired `workflow.json` envelope
// having been refused at the push boundary.
//
// DB-gated: skipped when DATABASE_URL is unset, so a fresh checkout
// still runs the unit gates. Run with e.g.
// `DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import {
  createDB,
  loadFrozenGrantSnapshot,
  loadFrozenWireProjection,
} from "@intx/db";
import {
  asset as assetTable,
  principal as principalTable,
  tenant as tenantTable,
} from "@intx/db/schema";
import { createAgentRepoStore, createAssetService } from "@intx/hub-sessions";
import { generateKeyPair } from "@intx/crypto";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { applyAgentDirectoryMigrations } from "../src/migrations";
import { definitionSkills } from "../src/schema";
import { createAgentDefinitionRoutes } from "../src/routes";
import { createDefinitionFreezer } from "@corbits/workflow-freeze";
import type { PinnedSkillIndexResolver } from "../src/routes";
import { createDrizzleDefinitionSkillsStore } from "../src/skills-store";
import type { DefinitionAssetHistory } from "../src/definition-history";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const suffix = randomUUID().slice(0, 8);
const TENANT = {
  id: `tnt_agtdir_it_${suffix}`,
  name: "Agent Directory IT",
  slug: `agent-directory-it-${suffix}`,
  domain: `agent-directory-it-${suffix}.example`,
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: `prn_agtdir_it_${suffix}`,
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: `usr_agtdir_it_${suffix}`,
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [],
      skills: [{ name: "research" }],
      models: [],
    }),
};

const fakeSkillIndex: PinnedSkillIndexResolver = {
  resolve: (_tenantId, _principalId, names) =>
    Promise.resolve(
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
};

const fakeHistory: DefinitionAssetHistory = {
  history: () => Promise.resolve([]),
  readBlobAtCommit: () => Promise.resolve(null),
};

const allowAllRequireGrant: RequireGrant = () => async (_c, next) => {
  await next();
};

async function post(app: Hono<TenantEnv>, body: unknown): Promise<Response> {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describeIfDb("agent-directory routes against a real assetService", () => {
  let dataDir: string;
  let db: ReturnType<typeof createDB>["db"];
  let close: () => Promise<void>;
  let app: Hono<TenantEnv>;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      throw new Error("DATABASE_URL is unset — describeIfDb should skip");
    }
    await applyAgentDirectoryMigrations(databaseUrl);

    const handle = createDB(dbTargetFromUrl(databaseUrl));
    db = handle.db;
    close = handle.close;

    await db.insert(tenantTable).values(TENANT).onConflictDoNothing();
    await db.insert(principalTable).values(PRINCIPAL).onConflictDoNothing();

    dataDir = await mkdtemp(path.join(tmpdir(), "agent-directory-it-"));
    const signingKey = await generateKeyPair();
    const agentRepoStore = createAgentRepoStore({ dataDir, signingKey });
    const assetService = createAssetService({
      db,
      repoStore: agentRepoStore.repoStore,
    });
    const skillsStore = createDrizzleDefinitionSkillsStore(db);

    const routes = createAgentDefinitionRoutes({
      db,
      assetService,
      skillIndex: fakeSkillIndex,
      skillsStore,
      history: fakeHistory,
      capabilityInventory: fakeCapabilityInventory,
      requireGrant: allowAllRequireGrant,
      definitionFreezer: createDefinitionFreezer(db),
    });
    const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
      c.set("tenant", TENANT);
      c.set("principal", PRINCIPAL);
      await next();
    };
    app = new Hono<TenantEnv>();
    app.use("*", asPrincipal);
    app.route("/", routes);
  }, 30000);

  afterAll(async () => {
    const assetRows = await db
      .select({ id: assetTable.id })
      .from(assetTable)
      .where(eq(assetTable.tenantId, TENANT.id));
    const assetIds = assetRows.map((row) => row.id);
    if (assetIds.length > 0) {
      await db
        .delete(definitionSkills)
        .where(inArray(definitionSkills.assetId, assetIds));
    }
    await db.delete(tenantTable).where(eq(tenantTable.id, TENANT.id));
    await close();
    await rm(dataDir, { recursive: true, force: true });
  }, 30000);

  test("creating a definition with skills no longer 500s with a path_violation", async () => {
    const response = await post(app, {
      name: "Research Buddy",
      handle: `research-buddy-${suffix}`,
      systemPrompt: "You are a careful research assistant.",
      skills: ["research"],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { skills: string[] };
    expect(body.skills).toEqual(["research"]);
  });

  test("skills round-trip: create with skills, GET reflects them, PUT updates, GET reflects the update", async () => {
    const handle = `round-trip-${suffix}`;
    const created = await post(app, {
      name: "Round Trip",
      handle,
      systemPrompt: "You help with round trips.",
      skills: ["research"],
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string };
    const definitionId = createdBody.id;

    const got = await app.request(`/${definitionId}`);
    expect(got.status).toBe(200);
    const gotBody = (await got.json()) as { skills: string[] };
    expect(gotBody.skills).toEqual(["research"]);

    const updated = await app.request(`/${definitionId}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skills: [] }),
    });
    expect(updated.status).toBe(200);

    const gotAfter = await app.request(`/${definitionId}`);
    const gotAfterBody = (await gotAfter.json()) as { skills: string[] };
    expect(gotAfterBody.skills).toEqual([]);
  });

  test("a created definition is launch-resolvable: its projection and grant snapshot are frozen (CL-6447)", async () => {
    const handle = `launchable-${suffix}`;
    const created = await post(app, {
      name: "Launchable",
      handle,
      systemPrompt: "You answer launch checks.",
      skills: [],
    });
    expect(created.status).toBe(201);
    const { id: definitionId } = (await created.json()) as { id: string };

    // The exact reads the chat invite path (`readDefinitionProjection`)
    // and the mail-triggered turn path (`loadFrozenGrantSnapshot`) fail
    // closed on: both must be frozen at create or the agent 409s
    // `not_launchable` forever.
    const projection = await loadFrozenWireProjection(db, definitionId);
    expect(projection).not.toBeNull();
    expect(JSON.stringify(projection)).toContain("You answer launch checks.");
    expect(await loadFrozenGrantSnapshot(db, definitionId)).not.toBeNull();

    // An instructions save re-freezes in place: the frozen projection
    // follows the edit under the same definition id.
    const updated = await app.request(`/${definitionId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Launchable",
        systemPrompt: "You answer edited launch checks.",
      }),
    });
    expect(updated.status).toBe(200);
    const refrozen = await loadFrozenWireProjection(db, definitionId);
    expect(JSON.stringify(refrozen)).toContain(
      "You answer edited launch checks.",
    );
  });
});
