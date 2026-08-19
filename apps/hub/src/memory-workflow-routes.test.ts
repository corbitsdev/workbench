// DB-gated integration test for CL-5852 M2/M3's real seam: a workflow
// run reaching the memory plane through `createWorkflowMemoryRoutes`
// (`@corbits/memory-hub`), backed by the SAME in-process `Memory`
// instance `mountMemory` mounts for real (not a fake store) — proving
// tenant isolation and the degraded-embedding lexical fallback against
// an actual Postgres `memory` schema, the same convention
// `memory-mount.test.ts` uses (`describeIfDb`, skipped when
// `DATABASE_URL` is unreachable).
//
// "No EMBED_BASE_URL" per CL-5852's test brief means no WORKING
// embedding backend, not a literally-unset env var — a genuinely unset
// one is now the legitimate lexical-only floor (see
// `memory-config.ts`'s `resolveConfigLexicalOnly`), not a degraded
// state. `EMBED_BASE_URL` here instead points at `localhost:9` (the
// "discard" port, always closed), the exact trick `memory-mount.test.ts`
// already uses: every embed call fails, forcing the plane's real runtime
// degrade (`services/search.ts`'s `degraded: ["dense_unavailable"]`)
// rather than a fake standing in for it — zero real keys, and the ONLY
// inference this test performs is the plane's own lexical (Postgres FTS)
// fallback.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";
import {
  createWorkflowMemoryRoutes,
  createWorkflowMemoryStore,
} from "@corbits/memory-hub";
import type { ResolvedWorkflowRunScope } from "@corbits/artifacts-hub";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { mountMemory } from "./memory-mount";

const KEYS = [
  "DATABASE_URL",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_API_STYLE",
  "EMBED_API_KEY",
] as const;

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

const TENANT_A: ResolvedWorkflowRunScope = {
  tenantId: "ten_memory_a",
  principalId: "prn_a",
  runId: "run_a",
};
const TENANT_B: ResolvedWorkflowRunScope = {
  tenantId: "ten_memory_b",
  principalId: "prn_b",
  runId: "run_b",
};
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

const WORKFLOW_ROUTES_SCHEMA = "hub_memory_workflow_routes_test";

describeIfDb(
  "createWorkflowMemoryRoutes against a real memory plane (degraded, no working embed)",
  () => {
    const target = dbTargetFromUrl(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );

    beforeAll(async () => {
      await runMigrations(target, { schema: WORKFLOW_ROUTES_SCHEMA });
    });

    afterAll(async () => {
      await dropSchema(target, { schema: WORKFLOW_ROUTES_SCHEMA });
      const postgres = (await import("postgres")).default;
      const sql = postgres(databaseUrl as string, { max: 1 });
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
      } finally {
        await sql.end();
      }
    });

    test("writes tenant-isolated rows and finds them lexically with the embed backend unreachable", async () => {
      stashEnv();
      process.env["DATABASE_URL"] = databaseUrl;
      process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
      process.env["EMBED_MODEL"] = "test-embedding-model";

      const { db, close } = createDB({
        ...target,
        schema: WORKFLOW_ROUTES_SCHEMA,
      });
      // No operator tenant configured on this deploy — each run's tenant
      // is already a root bench, so it resolves to itself (CL-6289's
      // account-scoping root rule); this proves that root rule end to end
      // over real HTTP rather than only unit-testing the resolver.
      await db.insert(schema.tenant).values({
        id: TENANT_A.tenantId,
        name: "Tenant A",
        slug: "memory-workflow-routes-tenant-a",
        domain: "memory-workflow-routes-tenant-a.workbench.test",
      });
      await db.insert(schema.tenant).values({
        id: TENANT_B.tenantId,
        name: "Tenant B",
        slug: "memory-workflow-routes-tenant-b",
        domain: "memory-workflow-routes-tenant-b.workbench.test",
      });

      const handle = await mountMemory({
        app: new Hono(),
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });

      const app = createWorkflowMemoryRoutes({
        authenticator: {
          async resolve(token) {
            if (token === TOKEN_A) return TENANT_A;
            if (token === TOKEN_B) return TENANT_B;
            return null;
          },
        },
        store: createWorkflowMemoryStore(handle.memory, { db }),
      });

      const addFor = (token: string, title: string, text: string) =>
        app.request("/add", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-workflow-run-address": "irrelevant-for-this-fake-authenticator",
            "content-type": "application/json",
          },
          body: JSON.stringify({ title, text }),
        });

      const searchFor = (token: string, query: string) =>
        app.request("/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-workflow-run-address": "irrelevant-for-this-fake-authenticator",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query }),
        });

      const addA = await addFor(
        TOKEN_A,
        "Decision A",
        "Tenant A decided to ship the memory tools this week.",
      );
      expect(addA.status).toBe(201);

      const addB = await addFor(
        TOKEN_B,
        "Decision B",
        "Tenant B decided to ship the memory tools this week.",
      );
      expect(addB.status).toBe(201);

      // Tenant A's search must find its own entry, and never tenant B's,
      // even though both entries share the same words — real Postgres
      // row-level tenant scoping, not a test double.
      const searchA = await searchFor(TOKEN_A, "ship the memory tools");
      expect(searchA.status).toBe(200);
      const bodyA = (await searchA.json()) as {
        data: { items: { title: string }[] };
      };
      // The embed backend at localhost:9 is unreachable (proven by the
      // "embedding pass failed" warning the plane itself logs on add),
      // yet the search below still finds tenant A's own entry — the
      // plane's real lexical (Postgres full-text) fallback, exercised
      // end to end rather than mocked.
      expect(bodyA.data.items.map((i) => i.title)).toEqual(["Decision A"]);

      const searchB = await searchFor(TOKEN_B, "ship the memory tools");
      const bodyB = (await searchB.json()) as {
        data: { items: { title: string }[] };
      };
      expect(bodyB.data.items.map((i) => i.title)).toEqual(["Decision B"]);

      await close();
    }, 20000);
  },
);
