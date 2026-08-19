// The one test that could actually have caught this: a real Postgres, the
// real DB-backed grant store, a real tenant hierarchy, and a run whose
// authority is minted by the real launch path — then a real HTTP call into
// the memory plane.
//
// Every memory test before this used `createInMemoryGrantStore`, whose own
// header states that `tenantId` "is accepted by the interface but is a no-op
// here" (`vendor/intx/authz/src/memory-store.ts`). That is precisely the axis
// this ticket is about: a grant row written in the wrong tenant matches
// nothing when a memory route asks. Against the in-memory store it matched
// anyway, so the suite was green while the plane was broken. Nothing here
// hand-plants a grant on the run; every row it asserts was computed at launch
// from what the invoker holds.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createGrantStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import { mintFoldedRun } from "@corbits/folded-runs";
import type { ResolvedWorkflowRunScope } from "@corbits/artifacts-hub";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { mountMemory } from "../src/memory-mount";
import { createRunHubGrantPlane } from "../src/run-hub-grants";
import { createHubGrantRequirementsForPins } from "../src/tool-grants";

const KEYS = ["DATABASE_URL", "EMBED_BASE_URL", "EMBED_MODEL"] as const;
type EnvKey = (typeof KEYS)[number];
const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  process.env[key] = undefined;
}

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
});

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const SCHEMA = "hub_memory_invoker_bounded_test";
const VALID_TOKEN = "valid-sidecar-token";
const RUN_ADDRESS = "irrelevant-for-this-fake-authenticator";
const MEMORY_TOOLS_PIN = [
  { name: "@corbits/memory-tools", version: "^1" },
] as const;

describeIfDb("a run's memory authority is bounded by its invoker", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCHEMA });
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  /**
   * The real hierarchy the account walk depends on: an operator tenant at
   * the top, one org (account) tenant beneath it, and a workbench tenant
   * beneath that. `invokerHoldsMemory: false` seeds a guest — a person with
   * a principal in the workbench and none in the org, which is how someone
   * invited into a single workbench actually looks.
   */
  async function seed(options: { invokerHoldsMemory: boolean }) {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
    process.env["EMBED_MODEL"] = "test-embedding-model";

    const { db, close } = createDB({ ...target, schema: SCHEMA });

    const operatorTenantId = generateId("tenant");
    const orgTenantId = generateId("tenant");
    const workbenchTenantId = generateId("tenant");
    for (const [id, name, parentId] of [
      [operatorTenantId, "Operator", null],
      [orgTenantId, "Org", operatorTenantId],
      [workbenchTenantId, "Workbench", orgTenantId],
    ] as const) {
      await db.insert(schema.tenant).values({
        id,
        name,
        slug: `${name.toLowerCase()}-${id}`,
        domain: `${id}.workbench.test`,
        parentId,
      });
    }

    const invokerUserId = generateId("user");
    const invokerWorkbenchPrincipalId = generateId("principal");
    await db.insert(schema.principal).values({
      id: invokerWorkbenchPrincipalId,
      tenantId: workbenchTenantId,
      kind: "user",
      refId: invokerUserId,
      status: "active",
    });

    let invokerOrgPrincipalId: string | null = null;
    if (options.invokerHoldsMemory) {
      invokerOrgPrincipalId = generateId("principal");
      await db.insert(schema.principal).values({
        id: invokerOrgPrincipalId,
        tenantId: orgTenantId,
        kind: "user",
        refId: invokerUserId,
        status: "active",
      });
      // The invoker's own authority, in the org tenant where memory lives.
      // This is the only grant anything plants; the run's own rows are
      // computed from it.
      for (const action of ["add", "search"]) {
        await db.insert(schema.grant).values({
          id: generateId("grant"),
          tenantId: orgTenantId,
          principalId: invokerOrgPrincipalId,
          resource: "memory",
          action,
          effect: "allow",
          conditions: null,
          origin: "system",
          expiresAt: null,
        });
      }
    }

    const definitionId = generateId("workflowDefinition");
    await db.insert(schema.workflowDefinition).values({
      id: definitionId,
      tenantId: workbenchTenantId,
      name: "memory-agent",
      status: "deployed",
    });

    const runHubGrants = createRunHubGrantPlane({
      db,
      grantStore: createGrantStore(db),
      requirementsForPins: createHubGrantRequirementsForPins(),
      operatorTenantId,
    });

    const instanceId = generateId("workflowRun");
    const launched = await mintFoldedRun(
      { db, runHubGrants },
      {
        tenantId: workbenchTenantId,
        instanceId,
        triggerAddress: `${instanceId}@${workbenchTenantId}.workbench.test`,
        definitionId,
        invokerPrincipalId: invokerWorkbenchPrincipalId,
        toolPackagePins: MEMORY_TOOLS_PIN,
      },
    );

    const runScope: ResolvedWorkflowRunScope = {
      tenantId: workbenchTenantId,
      principalId: launched.instancePrincipalId,
      runId: instanceId,
    };

    const app = new Hono();
    await mountMemory({
      app,
      db,
      databaseUrl: databaseUrl as string,
      // The real store, never `createInMemoryGrantStore`: a row in the wrong
      // tenant has to actually fail here.
      grantStore: createGrantStore(db),
      conditionRegistry: {},
      operatorTenantId,
      workflowRunAuthenticator: {
        async resolve(token) {
          return token === VALID_TOKEN ? runScope : null;
        },
      },
    });

    return {
      app,
      db,
      close,
      orgTenantId,
      workbenchTenantId,
      runPrincipalId: launched.instancePrincipalId,
    };
  }

  const searchRequest = () => ({
    method: "POST" as const,
    headers: {
      authorization: `Bearer ${VALID_TOKEN}`,
      "x-workflow-run-address": RUN_ADDRESS,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "anything" }),
  });

  const addRequest = () => ({
    method: "POST" as const,
    headers: {
      authorization: `Bearer ${VALID_TOKEN}`,
      "x-workflow-run-address": RUN_ADDRESS,
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "Decision", text: "Ship it." }),
  });

  test("launch writes the run's grants into the ORG tenant, where the routes resolve them from", async () => {
    const { db, close, orgTenantId, workbenchTenantId, runPrincipalId } =
      await seed({ invokerHoldsMemory: true });
    try {
      const rows = await db.query.grant.findMany({
        where: eq(schema.grant.principalId, runPrincipalId),
      });
      expect(
        rows
          .map((row) => `${row.resource}:${row.action}`)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(["memory:add", "memory:search"]);
      // The whole bug in one assertion: rows in the workbench tenant would
      // match nothing when a memory route asks, because the DB grant store
      // filters on `grant.tenantId`.
      expect(rows.every((row) => row.tenantId === orgTenantId)).toBe(true);
      expect(
        rows.some((row) => row.tenantId === workbenchTenantId),
      ).toBe(false);
      expect(rows.every((row) => row.origin === "invoker")).toBe(true);
      // No expiry: a woken run has no invoker left to renew a delegation.
      expect(rows.every((row) => row.expiresAt === null)).toBe(true);
    } finally {
      await close();
    }
  }, 20000);

  test("the run then reaches the memory plane over HTTP, with nothing hand-granted", async () => {
    const { app, close } = await seed({ invokerHoldsMemory: true });
    try {
      expect((await app.request("/api/tenants/x/memory/add", addRequest())).status).toBe(200);
      expect(
        (await app.request("/api/tenants/x/memory/search", searchRequest()))
          .status,
      ).toBe(200);
    } finally {
      await close();
    }
  }, 30000);

  test("an invoker who holds no memory here mints no rows, and the run's memory calls fail closed", async () => {
    const { app, db, close, runPrincipalId } = await seed({
      invokerHoldsMemory: false,
    });
    try {
      const rows = await db.query.grant.findMany({
        where: eq(schema.grant.principalId, runPrincipalId),
      });
      expect(rows).toEqual([]);

      // The run launched — it is addressable and its principal exists. It
      // simply cannot reach memory, which is the fail-closed outcome, not a
      // launch failure.
      expect((await app.request("/api/tenants/x/memory/search", searchRequest())).status).toBe(403);
      expect((await app.request("/api/tenants/x/memory/add", addRequest())).status).toBe(403);
    } finally {
      await close();
    }
  }, 30000);

  test("a run never picks up the routes-only forget or purge authority its invoker holds nothing for", async () => {
    const { db, close, runPrincipalId } = await seed({
      invokerHoldsMemory: true,
    });
    try {
      const overreach = await db.query.grant.findMany({
        where: and(
          eq(schema.grant.principalId, runPrincipalId),
          eq(schema.grant.action, "purge"),
        ),
      });
      expect(overreach).toEqual([]);
    } finally {
      await close();
    }
  }, 20000);
});
