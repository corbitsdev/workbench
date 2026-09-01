// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring @corbits/bench's migrations test.
// Runs against its own scratch database, never the developer's or the
// walking-skeleton suite's.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { setupDatabase } from "../../../scripts/db-setup";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { createDB } from "@intx/db";
import { grant, principal, principalRole, role, tenant } from "@intx/db/schema";
import { ensureDefaultTenant, type BootAdminAuth } from "./default-tenant";

function scratchUrlFor(e2eUrl: string): string {
  const url = new URL(e2eUrl);
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_default_tenant_test`;
  return url.toString();
}

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const ADMIN = { email: "admin@example.com", password: "password123" };
const ADMIN_USER_ID = "usr_boot_seed_admin";

/**
 * Structural double of the better-auth surface boot seeding uses,
 * recording what it was asked to do so tests can assert on the calls.
 */
function fakeBootAuth(opts?: { preexistingUserWithoutCredential?: boolean }) {
  const calls = { userCreated: 0, accountsLinked: 0, emailVerified: false };
  const linkedProviders = new Set<string>();
  const userExistsFromStart = opts?.preexistingUserWithoutCredential ?? false;
  const auth: BootAdminAuth = {
    $context: Promise.resolve({
      internalAdapter: {
        findUserByEmail: async (email) =>
          (userExistsFromStart || calls.userCreated > 0) && email === ADMIN.email
            ? { user: { id: ADMIN_USER_ID } }
            : null,
        createUser: async (user) => {
          calls.userCreated += 1;
          calls.emailVerified = user.emailVerified;
          return { id: ADMIN_USER_ID };
        },
        findAccounts: async (userId) => {
          if (userId !== ADMIN_USER_ID) return [];
          return [...linkedProviders].map((providerId) => ({ providerId }));
        },
        linkAccount: async (account) => {
          calls.accountsLinked += 1;
          linkedProviders.add(account.providerId);
        },
      },
      password: { hash: async (password) => `hashed(${password})` },
    }),
  };
  return { auth, calls };
}

describeIfDb("ensureDefaultTenant", () => {
  const scratchUrl = scratchUrlFor(
    databaseUrl ?? "postgres://localhost:5432/unused",
  );
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");
  const db = createDB({
    host: new URL(scratchUrl).hostname,
    port: Number(new URL(scratchUrl).port || 5432),
    user: decodeURIComponent(new URL(scratchUrl).username),
    password: decodeURIComponent(new URL(scratchUrl).password),
    database: scratchDatabase,
  });

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
    await setupDatabase(scratchUrl);
  }, 60000);

  afterAll(async () => {
    await db.close();
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
  }, 20000);

  async function rowsFor(slug: string) {
    return db.db.select().from(tenant).where(eq(tenant.slug, slug));
  }

  async function membershipsFor(tenantId: string) {
    return db.db
      .select()
      .from(principal)
      .where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user")));
  }

  test("creates the root tenant when absent, with a derived name, domain, and null parent", async () => {
    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "acme");
    expect(id).toMatch(/^tnt_/);
    const rows = await rowsFor("acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(id);
    expect(rows[0]?.name).toBe("Acme");
    expect(rows[0]?.domain).toBe("acme.localhost");
    expect(rows[0]?.parentId).toBeNull();
  });

  test("seeds the boot admin as an owner member of a freshly created root", async () => {
    const { auth, calls } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "seeded-root");

    expect(calls.userCreated).toBe(1);
    expect(calls.accountsLinked).toBe(1);
    expect(calls.emailVerified).toBe(true);

    const memberships = await membershipsFor(id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.refId).toBe(ADMIN_USER_ID);
    expect(memberships[0]?.status).toBe("active");

    const ownerRole = await db.db
      .select()
      .from(role)
      .where(and(eq(role.tenantId, id), eq(role.name, "owner")));
    expect(ownerRole).toHaveLength(1);
    const membership = memberships[0];
    if (!membership) throw new Error("expected membership");
    const links = await db.db
      .select()
      .from(principalRole)
      .where(eq(principalRole.principalId, membership.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.roleId).toBe(ownerRole[0]?.id);

    // Same grant shapes the native create-tenant route writes.
    const grants = await db.db
      .select()
      .from(grant)
      .where(eq(grant.tenantId, id));
    expect(grants).toHaveLength(5);
    const ownerGrant = grants.find(
      (g) => g.action === "*" && g.resource === "*",
    );
    expect(ownerGrant?.roleId).toBe(ownerRole[0]?.id);
    expect(ownerGrant?.effect).toBe("allow");
    expect(ownerGrant?.origin).toBe("system");
  });

  test("re-runs are a no-op: the tenant, roles, grants, and membership are not duplicated", async () => {
    const { auth } = fakeBootAuth();
    const first = await ensureDefaultTenant(db.db, auth, ADMIN, "acme");
    const second = await ensureDefaultTenant(db.db, auth, ADMIN, "acme");

    expect(second).toBe(first);
    expect(await rowsFor("acme")).toHaveLength(1);
    expect(await membershipsFor(first)).toHaveLength(1);
    expect(
      await db.db.select().from(role).where(eq(role.tenantId, first)),
    ).toHaveLength(3);
    expect(
      await db.db.select().from(grant).where(eq(grant.tenantId, first)),
    ).toHaveLength(5);
  });

  test("re-selects the winner when another boot already inserted the slug (race-safe)", async () => {
    // Simulates a concurrent hub winning the insert between this boot's
    // select and insert: the row already exists under a different id, so
    // the .onConflictDoNothing() insert is a no-op and the re-select must
    // return the winning row's id.
    const concurrentId = "tnt_concurrent_winner";
    await db.db
      .insert(tenant)
      .values({
        id: concurrentId,
        name: "Bee Co",
        slug: "bee-co",
        domain: "bee-co.localhost",
        parentId: null,
      })
      .onConflictDoNothing();
    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "bee-co");
    expect(id).toBe(concurrentId);
    expect(await rowsFor("bee-co")).toHaveLength(1);
  });

  test("an existing root with no members yet adopts the boot admin as owner", async () => {
    // A tenant created before boot seeded memberships: boot must claim it.
    await db.db.insert(tenant).values({
      id: "tnt_unowned",
      name: "Unowned",
      slug: "unowned",
      domain: "unowned.localhost",
      parentId: null,
    });
    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "unowned");
    expect(id).toBe("tnt_unowned");

    const memberships = await membershipsFor(id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.refId).toBe(ADMIN_USER_ID);
  });

  test("a tenant the admin already belongs to is left untouched (any role)", async () => {
    await db.db.insert(tenant).values({
      id: "tnt_already",
      name: "Already",
      slug: "already",
      domain: "already.localhost",
      parentId: null,
    });
    await db.db.insert(role).values({
      id: "rol_already_member",
      tenantId: "tnt_already",
      name: "member",
      isSystem: true,
    });
    await db.db.insert(principal).values({
      id: "prl_already_admin",
      tenantId: "tnt_already",
      kind: "user",
      refId: ADMIN_USER_ID,
      status: "active",
    });
    // give the admin the plain member role, not owner
    await db.db.insert(principalRole).values({
      principalId: "prl_already_admin",
      roleId: "rol_already_member",
    });

    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "already");
    expect(id).toBe("tnt_already");

    const memberships = await membershipsFor(id);
    expect(memberships).toHaveLength(1);
    const membership = memberships[0];
    if (!membership) throw new Error("expected membership");
    const links = await db.db
      .select()
      .from(principalRole)
      .where(eq(principalRole.principalId, membership.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.roleId).toBe("rol_already_member");
  });

  test("a tenant owned by someone else is left alone — the admin is not added", async () => {
    await db.db.insert(tenant).values({
      id: "tnt_foreign",
      name: "Foreign",
      slug: "foreign",
      domain: "foreign.localhost",
      parentId: null,
    });
    await db.db.insert(role).values({
      id: "rol_foreign_owner",
      tenantId: "tnt_foreign",
      name: "owner",
      isSystem: true,
    });
    await db.db.insert(principal).values({
      id: "prl_foreign_owner",
      tenantId: "tnt_foreign",
      kind: "user",
      refId: "usr_someone_else",
      status: "active",
    });

    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "foreign");
    expect(id).toBe("tnt_foreign");

    const memberships = await membershipsFor(id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.refId).toBe("usr_someone_else");
  });

  test("an existing admin user without a credential account gets one linked", async () => {
    // Partial failure: createUser committed, linkAccount threw. Re-boot
    // must still ensure a credential so sign-in works.
    const { auth, calls } = fakeBootAuth({
      preexistingUserWithoutCredential: true,
    });
    await ensureDefaultTenant(db.db, auth, ADMIN, "cred-repair");

    expect(calls.userCreated).toBe(0);
    expect(calls.accountsLinked).toBe(1);
  });

  test("an admin principal with no role gets the owner role attached on re-boot", async () => {
    // Partial failure: principal insert committed, principalRole threw.
    await db.db.insert(tenant).values({
      id: "tnt_roleless",
      name: "Roleless",
      slug: "roleless",
      domain: "roleless.localhost",
      parentId: null,
    });
    await db.db.insert(principal).values({
      id: "prl_roleless_admin",
      tenantId: "tnt_roleless",
      kind: "user",
      refId: ADMIN_USER_ID,
      status: "active",
    });

    const { auth } = fakeBootAuth();
    const id = await ensureDefaultTenant(db.db, auth, ADMIN, "roleless");
    expect(id).toBe("tnt_roleless");

    const memberships = await membershipsFor(id);
    expect(memberships).toHaveLength(1);
    const membership = memberships[0];
    if (!membership) throw new Error("expected membership");

    const ownerRole = await db.db
      .select()
      .from(role)
      .where(and(eq(role.tenantId, id), eq(role.name, "owner")));
    expect(ownerRole).toHaveLength(1);

    const links = await db.db
      .select()
      .from(principalRole)
      .where(eq(principalRole.principalId, membership.id));
    expect(links).toHaveLength(1);
    expect(links[0]?.roleId).toBe(ownerRole[0]?.id);
  });
});

