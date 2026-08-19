// DB-gated integration test for the real seam: a workflow run
// reaching the memory plane through `@corbits/memory`'s OWN
// `registerMemoryRoutes`, via `createAccountCallerResolver`'s workflow
// branch and `createWorkflowAddGuardMiddleware` — never the deleted
// `@corbits/memory-hub` package's bespoke routes — backed by the SAME
// in-process `Memory` instance `mountMemory` mounts for real (not a fake
// store), the same convention `memory-mount.test.ts` uses (`describeIfDb`,
// skipped when `DATABASE_URL` is unreachable).
//
// "No EMBED_BASE_URL" here means no WORKING embedding backend, not a
// literally-unset env var — a genuinely unset one is the legitimate
// lexical-only floor (`memory-config.ts`'s `resolveConfigLexicalOnly`).
// `EMBED_BASE_URL` points at `localhost:9` (the "discard" port, always
// closed), the exact trick `memory-mount.test.ts` already uses: every
// embed call fails, forcing the plane's real lexical (Postgres FTS)
// fallback rather than a fake standing in for it.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import { generateId } from "@intx/hub-common";
import {
  createDB,
  createGrantStore,
  runMigrations,
  dropSchema,
  schema,
} from "@intx/db";
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

const RUN_ID = "run_a";
const VALID_TOKEN = "valid-sidecar-token";
const RUN_ADDRESS = "irrelevant-for-this-fake-authenticator";

const WORKFLOW_ROUTES_SCHEMA = "hub_memory_workflow_routes_test";

describeIfDb(
  "workflow memory reaches @corbits/memory's own routes through createAccountCallerResolver's workflow branch",
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

    async function buildApp() {
      stashEnv();
      process.env["DATABASE_URL"] = databaseUrl;
      process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
      process.env["EMBED_MODEL"] = "test-embedding-model";

      const { db, close } = createDB({
        ...target,
        schema: WORKFLOW_ROUTES_SCHEMA,
      });

      const benchTenantId = generateId("tenant");
      const workbenchTenantId = generateId("tenant");
      await db.insert(schema.tenant).values({
        id: benchTenantId,
        name: "Bench",
        slug: `bench-${benchTenantId}`,
        domain: `${benchTenantId}.workbench.test`,
      });
      await db.insert(schema.tenant).values({
        id: workbenchTenantId,
        name: "Workbench",
        slug: `workbench-${workbenchTenantId}`,
        domain: `${workbenchTenantId}.workbench.test`,
        parentId: benchTenantId,
      });

      // A real principal row: the grant rows below carry an FK to it, so a
      // misplaced grant cannot be written at all.
      const runPrincipalId = generateId("principal");
      await db.insert(schema.principal).values({
        id: runPrincipalId,
        tenantId: workbenchTenantId,
        kind: "workflow",
        refId: RUN_ID,
        status: "active",
      });

      const runScope: ResolvedWorkflowRunScope = {
        tenantId: workbenchTenantId,
        principalId: runPrincipalId,
        runId: RUN_ID,
      };

      // Real rows in the ACCOUNT tenant, against the real DB-backed store —
      // the shape `launchFoldedRun` mints for a run (see
      // `apps/hub/test/memory-invoker-bounded.drizzle.test.ts`, which drives
      // the whole path end to end). `createInMemoryGrantStore` stood here
      // before and ignores `tenantId` outright, so these tests could not tell
      // a correctly scoped grant from a misplaced one.
      for (const action of ["add", "search"]) {
        await db.insert(schema.grant).values({
          id: generateId("grant"),
          tenantId: benchTenantId,
          principalId: runPrincipalId,
          resource: "memory",
          action,
          effect: "allow",
          conditions: null,
          origin: "invoker",
          expiresAt: null,
        });
      }

      const app = new Hono();
      const handle = await mountMemory({
        app,
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createGrantStore(db),
        conditionRegistry: {},
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
        benchTenantId,
        workbenchTenantId,
        handle,
        runPrincipalId,
      };
    }

    const addRequest = (token: string, title: string, text: string) => ({
      method: "POST" as const,
      headers: {
        authorization: `Bearer ${token}`,
        "x-workflow-run-address": RUN_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title, text }),
    });

    test("a valid run token writes into the ACCOUNT tenant's scope, not the run's own workbench tenant", async () => {
      const { app, close, benchTenantId, workbenchTenantId, handle, runPrincipalId } =
        await buildApp();
      try {
        const res = await app.request(
          "/api/tenants/whatever/memory/add",
          addRequest(VALID_TOKEN, "Decision", "Ship the memory migration."),
        );
        expect(res.status).toBe(200);

        const inAccountTenant = await handle.memory.list({
          tenantId: benchTenantId,
          principalId: runPrincipalId,
        });
        expect(inAccountTenant.map((e) => e.title)).toEqual(["Decision"]);

        const inWorkbenchTenant = await handle.memory.list({
          tenantId: workbenchTenantId,
          principalId: runPrincipalId,
        });
        expect(inWorkbenchTenant).toEqual([]);
      } finally {
        await close();
      }
    }, 20000);

    test("an invalid token 401s and never falls back to session auth", async () => {
      const { app, close } = await buildApp();
      try {
        const res = await app.request(
          "/api/tenants/whatever/memory/add",
          addRequest("not-a-real-token", "Title", "Text"),
        );
        expect(res.status).toBe(401);
      } finally {
        await close();
      }
    }, 20000);

    test("the 31st write in a minute is rate-limited", async () => {
      const { app, close } = await buildApp();
      try {
        let lastStatus = 0;
        for (let i = 0; i < 31; i++) {
          const res = await app.request(
            "/api/tenants/whatever/memory/add",
            addRequest(VALID_TOKEN, `Note ${i}`, "Body text"),
          );
          lastStatus = res.status;
          if (i < 30) expect(res.status).toBe(200);
        }
        expect(lastStatus).toBe(429);
      } finally {
        await close();
      }
    }, 30000);

    test("an oversized add is rejected before it reaches the plane", async () => {
      const { app, close } = await buildApp();
      try {
        const res = await app.request(
          "/api/tenants/whatever/memory/add",
          addRequest(VALID_TOKEN, "Title", "x".repeat(64_001)),
        );
        expect(res.status).toBe(413);
      } finally {
        await close();
      }
    }, 20000);

    test("a browser caller (no workflow headers) is unaffected by the cap and the rate limit", async () => {
      const { app, close } = await buildApp();
      try {
        // No principal on the request context and no workflow headers:
        // the request reaches neither branch of the resolver's identity
        // logic in a way that would apply cap/limit, and the plane's own
        // `requirePrincipal` guard 401s it before either matters — proving
        // the guard middleware passed the request straight through rather
        // than treating an unauthenticated browser-shaped request as a
        // workflow write.
        const res = await app.request("/api/tenants/whatever/memory/add", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Title", text: "x".repeat(64_001) }),
        });
        expect(res.status).toBe(401);
      } finally {
        await close();
      }
    }, 20000);
  },
);
