import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import { createInMemoryGrantStore } from "@intx/authz";
import { createDB, runMigrations, dropSchema, schema } from "@intx/db";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import {
  createAccountCallerResolver,
  createMemoryCallerScopeDescriber,
  mountMemory,
} from "./memory-mount";

const KEYS = ["DATABASE_URL", "EMBED_BASE_URL", "EMBED_MODEL"] as const;

type EnvKey = (typeof KEYS)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  // Prefer assignment over `delete process.env[key]` — eslint forbids dynamic delete.
  process.env[key] = undefined;
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
});

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
}

// DB-gated: skipped when DATABASE_URL is unreachable, matching this repo's
// existing convention for tests that talk to a real Postgres (see
// packages/approvals/test/needs-you.test.ts). There is no non-DB-gated
// path left to test: config is env-only now (CL-6289), but `mountMemory`
// always runs `runMemoryMigrations` against `DATABASE_URL` at boot — env,
// or the lexical-only floor, both still need a real Postgres to migrate.
const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = databaseUrl === undefined ? describe.skip : describe;

const CORE_SCHEMA = "hub_memory_mount_test";

describeIfDb("mountMemory", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: CORE_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: CORE_SCHEMA });
    const postgres = (await import("postgres")).default;
    const sql = postgres(databaseUrl as string, { max: 1 });
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
    } finally {
      await sql.end();
    }
  });

  test("mounts at boot — migrations run and tables land under `memory`, never `public`", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
    try {
      const app = new Hono();
      const handle = await mountMemory({
        app,
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });
      expect(handle.memory).toBeDefined();

      const postgres = (await import("postgres")).default;
      const sql = postgres(databaseUrl as string, { max: 1 });
      try {
        const memoryTables = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'memory'
        `;
        expect(memoryTables.length).toBeGreaterThan(0);

        const publicLeaks = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('document', 'raw_capture', '_migrations')
        `;
        expect(publicLeaks.length).toBe(0);
      } finally {
        await sql.end();
      }
    } finally {
      await close();
    }
  });

  test("registers the status route at /api/tenants/:tenantId/memory/status", async () => {
    stashEnv();
    process.env["DATABASE_URL"] = databaseUrl;
    const { db, close } = createDB({ ...target, schema: CORE_SCHEMA });
    try {
      const app = new Hono();
      await mountMemory({
        app,
        db,
        databaseUrl: databaseUrl as string,
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });
      // No principal on the request context: the status route's own
      // fail-closed guard rejects with 401 before the status handler ever
      // runs — this only proves the route exists and is guarded.
      const res = await app.request("/api/tenants/tnt_1/memory/status");
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });
});

const CALLER_RESOLVER_SCHEMA = "hub_memory_caller_resolver_test";

type Seat = {
  tenantId: string;
  principalId: string;
  refId: string;
  kind?: "user" | "agent" | "workflow";
};

function appSeatedAs(
  seat: Seat,
  resolve: (
    c: Parameters<ReturnType<typeof createAccountCallerResolver>>[0],
  ) => unknown,
) {
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", {
      id: seat.tenantId,
      name: seat.tenantId,
      slug: seat.tenantId,
      domain: `${seat.tenantId}.workbench.test`,
      parentId: null,
      config: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    c.set("principal", {
      id: seat.principalId,
      tenantId: seat.tenantId,
      kind: seat.kind ?? "user",
      refId: seat.refId,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await next();
  });
  app.get("/resolve", async (c) => {
    const resolved = await resolve(c);
    return c.json(resolved);
  });
  return app;
}

function appWithResolver(
  db: Parameters<typeof createAccountCallerResolver>[0],
  operatorTenantId: string | undefined,
  seat: Seat,
) {
  const resolver = createAccountCallerResolver(db, operatorTenantId);
  return appSeatedAs(seat, (c) => resolver(c));
}

function appWithScopeDescriber(
  db: Parameters<typeof createMemoryCallerScopeDescriber>[0],
  operatorTenantId: string | undefined,
  seat: Seat,
) {
  const describeScope = createMemoryCallerScopeDescriber(db, operatorTenantId);
  return appSeatedAs(seat, (c) => describeScope(c));
}

async function seedOrgAndWorkbench(
  db: ReturnType<typeof createDB>["db"],
  slug: string,
): Promise<{ orgTenantId: string; workbenchTenantId: string }> {
  const orgTenantId = `tnt_${slug}_org`;
  const workbenchTenantId = `tnt_${slug}_workbench`;
  await db.insert(schema.tenant).values({
    id: orgTenantId,
    name: "Org",
    slug: `${slug}-org`,
    domain: `${slug}-org.workbench.test`,
  });
  await db.insert(schema.tenant).values({
    id: workbenchTenantId,
    name: "Workbench",
    slug: `${slug}-workbench`,
    domain: `${slug}-workbench.workbench.test`,
    parentId: orgTenantId,
  });
  return { orgTenantId, workbenchTenantId };
}

// `createAccountCallerResolver` is `registerMemoryRoutes`'s `CallerResolver`
// — the seam every memory route's identity actually flows through (see
// `memory-mount.ts`'s module doc comment). Exercised here as an isolated
// unit against a real tenant hierarchy: this is where the security property
// — a person's memory follows their org principal across every workbench
// under that org, a guest reaches nothing, and nobody reaches into the
// operator tenant — actually gets wired to HTTP.
describeIfDb("createAccountCallerResolver", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: CALLER_RESOLVER_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: CALLER_RESOLVER_SCHEMA });
  });

  test("resolves a member to their OWN principal in the org tenant, not the workbench principal they are calling with", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const { orgTenantId, workbenchTenantId } = await seedOrgAndWorkbench(
        db,
        "member",
      );
      // The same user, twice: one principal per tenancy. Memory lives in the
      // org tenant, so the org row is the one whose grants must be consulted.
      await db.insert(schema.principal).values([
        {
          id: "prn_member_workbench",
          tenantId: workbenchTenantId,
          kind: "user",
          refId: "usr_member",
          status: "active",
        },
        {
          id: "prn_member_org",
          tenantId: orgTenantId,
          kind: "user",
          refId: "usr_member",
          status: "active",
        },
      ]);

      const app = appWithResolver(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_member_workbench",
        refId: "usr_member",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({
        tenantId: orgTenantId,
        principalId: "prn_member_org",
      });
    } finally {
      await close();
    }
  });

  test("resolves the same user to the same org principal from two different workbenches under one org", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const { orgTenantId, workbenchTenantId } = await seedOrgAndWorkbench(
        db,
        "shared",
      );
      const secondWorkbenchTenantId = "tnt_shared_workbench_two";
      await db.insert(schema.tenant).values({
        id: secondWorkbenchTenantId,
        name: "Second workbench",
        slug: "shared-workbench-two",
        domain: "shared-workbench-two.workbench.test",
        parentId: orgTenantId,
      });
      await db.insert(schema.principal).values([
        {
          id: "prn_shared_org",
          tenantId: orgTenantId,
          kind: "user",
          refId: "usr_shared",
          status: "active",
        },
        {
          id: "prn_shared_wb_one",
          tenantId: workbenchTenantId,
          kind: "user",
          refId: "usr_shared",
          status: "active",
        },
        {
          id: "prn_shared_wb_two",
          tenantId: secondWorkbenchTenantId,
          kind: "user",
          refId: "usr_shared",
          status: "active",
        },
      ]);

      const expected = {
        tenantId: orgTenantId,
        principalId: "prn_shared_org",
      };
      for (const seat of [
        { tenantId: workbenchTenantId, principalId: "prn_shared_wb_one" },
        { tenantId: secondWorkbenchTenantId, principalId: "prn_shared_wb_two" },
      ]) {
        const app = appWithResolver(db, undefined, {
          ...seat,
          refId: "usr_shared",
        });
        const res = await app.request("/resolve");
        expect(await res.json()).toEqual(expected);
      }
    } finally {
      await close();
    }
  });

  test("resolves a guest with no principal in the host org to null — the host's memory is never exposed to them", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const { workbenchTenantId } = await seedOrgAndWorkbench(db, "guest");
      // The guest is a member of the workbench they were invited into and
      // nothing else: their own parent tenancy is elsewhere entirely.
      await db.insert(schema.principal).values({
        id: "prn_guest_workbench",
        tenantId: workbenchTenantId,
        kind: "user",
        refId: "usr_guest",
        status: "active",
      });

      const app = appWithResolver(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_guest_workbench",
        refId: "usr_guest",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toBeNull();
    } finally {
      await close();
    }
  });

  test("resolves a non-user principal kind to null — only a person proxies through their org principal", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const { orgTenantId, workbenchTenantId } = await seedOrgAndWorkbench(
        db,
        "kind",
      );
      // A same-refId user row in the org exists on purpose: the denial must
      // come from the caller's kind, never from a missing lookup target.
      await db.insert(schema.principal).values({
        id: "prn_kind_org",
        tenantId: orgTenantId,
        kind: "user",
        refId: "wfr_run",
        status: "active",
      });

      const app = appWithResolver(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_kind_run",
        refId: "wfr_run",
        kind: "workflow",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toBeNull();
    } finally {
      await close();
    }
  });

  test("a caller whose own tenant IS the operator tenant resolves to null (401 via resolveCaller), never a fallback scope", async () => {
    const { db, close } = createDB({
      ...target,
      schema: CALLER_RESOLVER_SCHEMA,
    });
    try {
      const operatorTenantId = "tnt_resolver_operator";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "resolver-operator",
        domain: "resolver-operator.workbench.test",
      });

      const app = appWithResolver(db, operatorTenantId, {
        tenantId: operatorTenantId,
        principalId: "prn_operator_admin",
        refId: "usr_operator_admin",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toBeNull();
    } finally {
      await close();
    }
  });
});

const SCOPE_DESCRIBER_SCHEMA = "hub_memory_scope_describer_test";

// The Memory page reads this, and every memory data route reads
// `createAccountCallerResolver`. Both run the same rule, so a person is
// never told they have memory here and then refused when they use it —
// which is what a bare 403 mid-page used to look like.
describeIfDb("createMemoryCallerScopeDescriber", () => {
  const target = dbTargetFromUrl(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );

  beforeAll(async () => {
    await runMigrations(target, { schema: SCOPE_DESCRIBER_SCHEMA });
  });

  afterAll(async () => {
    await dropSchema(target, { schema: SCOPE_DESCRIBER_SCHEMA });
  });

  test("reports a member as scoped", async () => {
    const { db, close } = createDB({
      ...target,
      schema: SCOPE_DESCRIBER_SCHEMA,
    });
    try {
      const { orgTenantId, workbenchTenantId } = await seedOrgAndWorkbench(
        db,
        "scoped",
      );
      await db.insert(schema.principal).values({
        id: "prn_scoped_org",
        tenantId: orgTenantId,
        kind: "user",
        refId: "usr_scoped",
        status: "active",
      });

      const app = appWithScopeDescriber(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_scoped_workbench",
        refId: "usr_scoped",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({ kind: "scoped" });
    } finally {
      await close();
    }
  });

  test("names a guest's missing org principal, so the page can explain it instead of reporting a fault", async () => {
    const { db, close } = createDB({
      ...target,
      schema: SCOPE_DESCRIBER_SCHEMA,
    });
    try {
      const { workbenchTenantId } = await seedOrgAndWorkbench(db, "unscoped");

      const app = appWithScopeDescriber(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_unscoped_workbench",
        refId: "usr_unscoped",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({
        kind: "unscoped",
        reason: "no-org-principal",
      });
    } finally {
      await close();
    }
  });

  test("names the operator tenant's missing account rather than blaming the caller", async () => {
    const { db, close } = createDB({
      ...target,
      schema: SCOPE_DESCRIBER_SCHEMA,
    });
    try {
      const operatorTenantId = "tnt_describer_operator";
      await db.insert(schema.tenant).values({
        id: operatorTenantId,
        name: "Operator",
        slug: "describer-operator",
        domain: "describer-operator.workbench.test",
      });

      const app = appWithScopeDescriber(db, operatorTenantId, {
        tenantId: operatorTenantId,
        principalId: "prn_describer_admin",
        refId: "usr_describer_admin",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({
        kind: "unscoped",
        reason: "no-account-tenant",
      });
    } finally {
      await close();
    }
  });

  test("names a non-person caller — a run reaches memory through its own granted authority, never this browser surface", async () => {
    const { db, close } = createDB({
      ...target,
      schema: SCOPE_DESCRIBER_SCHEMA,
    });
    try {
      const { workbenchTenantId } = await seedOrgAndWorkbench(db, "nonperson");

      const app = appWithScopeDescriber(db, undefined, {
        tenantId: workbenchTenantId,
        principalId: "prn_nonperson_run",
        refId: "wfr_nonperson",
        kind: "workflow",
      });
      const res = await app.request("/resolve");
      expect(await res.json()).toEqual({
        kind: "unscoped",
        reason: "not-a-person",
      });
    } finally {
      await close();
    }
  });
});
