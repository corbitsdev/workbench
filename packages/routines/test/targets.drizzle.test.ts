// DB-gated: skipped when no DATABASE_URL is reachable, mirroring
// store.drizzle.test.ts. Proves the one target-discovery query every
// routine-authoring surface reads (CL-7351): newest frozen deployed
// definition per asset, authorized per row before any metadata leaves,
// filtered to what the product offers as a routine target, paged in a
// deterministic order.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type } from "arktype";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import { createDB, createGrantStore, dropSchema, runMigrations, schema } from "@intx/db";
import type { TenantEnv } from "@intx/hub-api";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { listLaunchableDefinitions, listRoutineTargets } from "../src/targets";
import { createRoutineTargetRoutes } from "../src/targets-route";
import { RoutineTargetsResponse } from "../src/client";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "routine_targets_test";
const TENANT = "tnt_routine_targets";
const OTHER_TENANT = "tnt_routine_targets_other";
const READER = "prn_routine_targets_reader";
const STRANGER = "prn_routine_targets_stranger";
const OTHER_TENANT_READER = "prn_routine_targets_other_reader";

const AGENT_PROJECTION = {
  id: "agent-fold",
  triggers: [],
  stepOrder: ["converse"],
  steps: {
    converse: {
      kind: "step",
      agent: { systemPrompt: "Be helpful.", modelSources: [] },
    },
  },
};

const WORKFLOW_PROJECTION = {
  id: "two-steps",
  triggers: [],
  stepOrder: ["gather", "write"],
  steps: {
    gather: { kind: "step", agent: { systemPrompt: "Gather.", modelSources: [] } },
    write: { kind: "step", agent: { systemPrompt: "Write.", modelSources: [] } },
  },
};

type Db = ReturnType<typeof createDB>["db"];

type Fixture = {
  readonly id: string;
  readonly tenantId?: string;
  readonly assetId: string;
  readonly name: string;
  readonly description?: string;
  readonly createdAt: Date;
  readonly frozen: boolean;
  readonly projection?: unknown;
  readonly origin?: "authored" | "run";
};

async function insertDefinition(db: Db, fixture: Fixture): Promise<void> {
  const tenantId = fixture.tenantId ?? TENANT;
  await db
    .insert(schema.asset)
    .values({
      id: fixture.assetId,
      tenantId,
      kind: "workflow",
      name: fixture.assetId,
    })
    .onConflictDoNothing();
  await db.insert(schema.workflowDefinition).values({
    id: fixture.id,
    tenantId,
    assetId: fixture.assetId,
    wireHash: `hash-${fixture.id}`,
    name: fixture.name,
    description: fixture.description ?? null,
    origin: fixture.origin ?? "authored",
    status: "deployed",
    createdAt: fixture.createdAt,
  });
  await db.insert(schema.workflowDefinitionVersion).values({
    id: `${fixture.id}-v1`,
    definitionId: fixture.id,
    version: "1",
    ...(fixture.frozen
      ? {
          approvedWireHash: `hash-${fixture.id}`,
          grantSnapshot: { grants: [] },
          wireProjection: fixture.projection ?? WORKFLOW_PROJECTION,
        }
      : {}),
  });
}

describeIfDb("routine target discovery", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  async function withDb<T>(run: (db: Db) => Promise<T>): Promise<T> {
    const { db, close } = createDB({ ...target, schema: SCHEMA });
    try {
      return await run(db);
    } finally {
      await close();
    }
  }

  function targetsFor(db: Db) {
    return {
      db,
      grantStore: createGrantStore(db),
      conditionRegistry: {},
    };
  }

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
    await withDb(async (db) => {
      await db.insert(schema.tenant).values([
        {
          id: TENANT,
          name: "Routine Targets",
          slug: "routine-targets",
          domain: "routine-targets.localhost",
        },
        {
          id: OTHER_TENANT,
          name: "Routine Targets Other",
          slug: "routine-targets-other",
          domain: "routine-targets-other.localhost",
        },
      ]);
      await db.insert(schema.principal).values([
        { id: READER, tenantId: TENANT, kind: "user", refId: "reader", status: "active" },
        { id: STRANGER, tenantId: TENANT, kind: "user", refId: "stranger", status: "active" },
        {
          id: OTHER_TENANT_READER,
          tenantId: OTHER_TENANT,
          kind: "user",
          refId: "other",
          status: "active",
        },
      ]);
      await db.insert(schema.grant).values([
        {
          id: "grt_routine_targets_reader",
          tenantId: TENANT,
          principalId: READER,
          resource: "workflow-definition:*",
          action: "read",
          effect: "allow",
          origin: "system",
        },
        {
          id: "grt_routine_targets_other_reader",
          tenantId: OTHER_TENANT,
          principalId: OTHER_TENANT_READER,
          resource: "workflow-definition:*",
          action: "read",
          effect: "allow",
          origin: "system",
        },
      ]);

      const t = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
      // Catalog-automatable workflow, redeployed once: only the newest row counts.
      await insertDefinition(db, {
        id: "wfd_digest_old",
        assetId: "ast_digest",
        name: "workbench-digest",
        createdAt: t(1),
        frozen: true,
      });
      await insertDefinition(db, {
        id: "wfd_digest_new",
        assetId: "ast_digest",
        name: "workbench-digest",
        createdAt: t(2),
        frozen: true,
      });
      // Catalog-automatable workflow whose only deploy never froze.
      await insertDefinition(db, {
        id: "wfd_heartbeat_unfrozen",
        assetId: "ast_heartbeat",
        name: "heartbeat",
        createdAt: t(3),
        frozen: false,
      });
      // Runtime-created conversational agent: a single-step fold.
      await insertDefinition(db, {
        id: "wfd_agent",
        assetId: "ast_agent",
        name: "ada-research-agent",
        description: "Ada",
        createdAt: t(4),
        frozen: true,
        projection: AGENT_PROJECTION,
      });
      // The same agent's per-run deploy record is never a launch candidate.
      await insertDefinition(db, {
        id: "wfd_agent_run_clone",
        assetId: "ast_agent",
        name: "ada-research-agent",
        description: "Ada",
        createdAt: t(5),
        frozen: true,
        projection: AGENT_PROJECTION,
        origin: "run",
      });
      // Workbench-host anchor definitions are plumbing, not targets.
      await insertDefinition(db, {
        id: "wfd_host",
        assetId: "ast_host",
        name: "ins-0123456789abcdef0123456789abcdef",
        createdAt: t(6),
        frozen: true,
        projection: AGENT_PROJECTION,
      });
      // Catalog utility that is neither automatable nor conversational.
      await insertDefinition(db, {
        id: "wfd_echo",
        assetId: "ast_echo",
        name: "echo",
        createdAt: t(7),
        frozen: true,
      });
      // Another tenant's frozen deployed workflow.
      await insertDefinition(db, {
        id: "wfd_other_tenant",
        tenantId: OTHER_TENANT,
        assetId: "ast_other_digest",
        name: "workbench-digest",
        createdAt: t(8),
        frozen: true,
      });
    });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
  });

  test("listLaunchableDefinitions keeps the newest frozen authored row per asset in the tenant", async () => {
    await withDb(async (db) => {
      const rows = await listLaunchableDefinitions(db, TENANT);
      const byAsset = new Map(rows.map((row) => [row.definitionAssetId, row]));
      expect(byAsset.get("ast_digest")?.definitionId).toBe("wfd_digest_new");
      expect(byAsset.get("ast_digest")?.wireHash).toBe("hash-wfd_digest_new");
      expect(byAsset.has("ast_heartbeat")).toBe(false);
      expect(byAsset.get("ast_agent")?.definitionId).toBe("wfd_agent");
      expect(byAsset.has("ast_other_digest")).toBe(false);
    });
  });

  test("a principal with the read grant sees agents and workflows, ordered by name then asset", async () => {
    await withDb(async (db) => {
      const page = await listRoutineTargets(targetsFor(db), {
        tenantId: TENANT,
        principalId: READER,
        limit: 50,
      });
      expect(page.nextCursor).toBeNull();
      expect(page.items).toEqual([
        {
          definitionAssetId: "ast_agent",
          definitionId: "wfd_agent",
          assetName: "ada-research-agent",
          name: "Ada",
          description: "Ada",
          kind: "agent",
          wireHash: "hash-wfd_agent",
        },
        {
          definitionAssetId: "ast_digest",
          definitionId: "wfd_digest_new",
          assetName: "workbench-digest",
          name: "Workbench Digest",
          description: null,
          kind: "workflow",
          wireHash: "hash-wfd_digest_new",
        },
      ]);
    });
  });

  test("a principal without the grant sees nothing", async () => {
    await withDb(async (db) => {
      const page = await listRoutineTargets(targetsFor(db), {
        tenantId: TENANT,
        principalId: STRANGER,
        limit: 50,
      });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  test("a grant in another tenant does not reach across", async () => {
    await withDb(async (db) => {
      const page = await listRoutineTargets(targetsFor(db), {
        tenantId: TENANT,
        principalId: OTHER_TENANT_READER,
        limit: 50,
      });
      expect(page.items).toEqual([]);
    });
  });

  test("a tenant with no frozen definitions yields an empty page", async () => {
    await withDb(async (db) => {
      const page = await listRoutineTargets(targetsFor(db), {
        tenantId: "tnt_routine_targets_empty",
        principalId: READER,
        limit: 50,
      });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });

  test("cursor continuation walks the ordered list without repeats or gaps", async () => {
    await withDb(async (db) => {
      const first = await listRoutineTargets(targetsFor(db), {
        tenantId: TENANT,
        principalId: READER,
        limit: 1,
      });
      expect(first.items.map((item) => item.definitionId)).toEqual(["wfd_agent"]);
      expect(first.nextCursor).not.toBeNull();
      const second = await listRoutineTargets(targetsFor(db), {
        tenantId: TENANT,
        principalId: READER,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((item) => item.definitionId)).toEqual([
        "wfd_digest_new",
      ]);
      expect(second.nextCursor).toBeNull();
    });
  });

  test("GET /workflows/targets serves the page in the client wire shape", async () => {
    await withDb(async (db) => {
      const asReader: MiddlewareHandler<TenantEnv> = async (c, next) => {
        c.set("tenant", { id: TENANT } as never);
        c.set("principal", { id: READER, tenantId: TENANT } as never);
        await next();
      };
      const app = new Hono<TenantEnv>();
      app.use("*", asReader);
      app.route("/workflows/targets", createRoutineTargetRoutes(targetsFor(db)));

      const res = await app.request("/workflows/targets?limit=1");
      expect(res.status).toBe(200);
      const body = RoutineTargetsResponse(await res.json());
      if (body instanceof type.errors) throw new Error(body.summary);
      expect(body.items.map((item) => item.kind)).toEqual(["agent"]);
      expect(body.nextCursor).not.toBeNull();

      const bad = await app.request("/workflows/targets?cursor=not-a-cursor");
      expect(bad.status).toBe(400);
    });
  });
});
