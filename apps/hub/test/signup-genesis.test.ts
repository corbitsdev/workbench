// CL-7578 end-to-end proof of the 0→1 contract: a hub booted on an
// empty database starts truly empty, and the first signup — not a CLI,
// not a boot-time seed — mints the root tenant and becomes its owner.
// The second signup joins that root as a plain member. Signup never
// seeds workflows, tools, or grants.
//
// DB-gated: each test boots a full hub against its own scratch
// database, so a reachable DATABASE_URL is required and the suite
// skips without one.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  principal,
  principalRole,
  role,
  tenant,
  user as userTable,
} from "@intx/db/schema";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";
import { e2eDatabaseUrl } from "../../../scripts/e2e/database-url";
import { setupDatabase } from "../../../scripts/db-setup";
import { dbGate } from "../../../scripts/e2e/db-gate";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  let closer: (() => Promise<void>) | undefined;
  while ((closer = closers.pop()) !== undefined) {
    try {
      await closer();
    } catch (cause) {
      console.log("SCRATCH-STOP-THREW", cause);
    }
  }
}, 60_000);

function scratchUrlFor(label: string): string {
  const url = new URL(databaseUrl ?? "postgres://localhost:5432/unused");
  const database = url.pathname.replace(/^\//, "");
  url.pathname = `/${database}_signup_genesis_${label}`;
  return url.toString();
}

async function withScratchDatabase(
  scratchUrl: string,
  run: () => Promise<void>,
): Promise<void> {
  const maintenanceUrl = new URL(scratchUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = postgres(maintenanceUrl.toString(), {
    max: 1,
    onnotice: () => undefined,
  });
  const scratchDatabase = new URL(scratchUrl).pathname.replace(/^\//, "");
  try {
    await maintenance.unsafe(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
    await maintenance.unsafe(`CREATE DATABASE "${scratchDatabase}"`);
  } finally {
    await maintenance.end();
  }
  await setupDatabase(scratchUrl);
  try {
    await run();
  } finally {
    const cleanup = postgres(maintenanceUrl.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await cleanup.unsafe(
        `DROP DATABASE IF EXISTS "${scratchDatabase}" WITH (FORCE)`,
      );
    } finally {
      await cleanup.end();
    }
  }
}

async function bootEmptyHub(args: {
  scratchUrl: string;
  signupMode: "open" | "closed";
}): Promise<{
  baseUrl: string;
  db: Awaited<ReturnType<typeof createHub>>["db"];
  stop: () => Promise<void>;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "hub-signup-genesis-"));
  const staticDir = path.join(root, "static");
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
  mkdirSync(path.join(root, "data"), { recursive: true });

  // The onboarding routes reach the hub over HTTP (`createHubAPI`), so
  // the composed app must be served on a real port — bind first to
  // learn the port, boot the hub against that base URL, then hand the
  // server the app.
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("booting", { status: 503 }),
  });
  const baseUrl = `http://localhost:${server.port}`;
  const config: HubConfig = {
    databaseUrl: args.scratchUrl,
    baseUrl,
    sessionSecret: "insecure-test-only-session-secret-0000",
    hubDataDir: path.join(root, "data"),
    hubStaticDir: staticDir,
    defaultTenantSlug: "workbench",
    signupRateLimit: { windowSeconds: 60, max: 5 },
    signInRateLimit: { windowSeconds: 60, max: 10 },
    socialProviders: {},
    signupMode: args.signupMode,
    allowedEmailDomains: [],
    allowPlaintextSecrets: true,
    allowUnverifiedEmails: true,
    sidecarProvisioners: [],
    chatIdleReapMs: 30 * 60_000,
  };
  const hub = await createHub(config);
  server.reload({ fetch: hub.app.fetch });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  };
  closers.push(stop);
  return { baseUrl, db: hub.db, stop };
}

// Distinct client IP per sign-up: better-auth's rate-limit storage is
// shared across every hub instance in this test process and keyed on
// the resolved client IP, so without this the suite's sign-ups all
// land in one budget bucket and can starve sibling suites
// (composition.test.ts signs up against the same bucket).
let signUpIpCounter = 0;

async function signUp(
  baseUrl: string,
  args: { name: string; email: string; password: string },
): Promise<string[]> {
  signUpIpCounter += 1;
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": `198.51.100.${signUpIpCounter}`,
    },
    body: JSON.stringify(args),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  return cookies;
}

async function provision(
  baseUrl: string,
  cookies: string[],
  name?: string,
): Promise<{
  kind: string;
  tenantId?: string;
  tenantSlug?: string;
  seeded?: boolean;
}> {
  const response = await fetch(`${baseUrl}/api/onboarding/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: cookies.join("; "),
    },
    ...(name !== undefined ? { body: JSON.stringify({ name }) } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    kind: string;
    tenantId?: string;
    tenantSlug?: string;
    seeded?: boolean;
  };
}

async function roleNamesFor(
  db: Awaited<ReturnType<typeof createHub>>["db"],
  args: { tenantId: string; email: string },
): Promise<string[]> {
  const [userRow] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, args.email))
    .limit(1);
  expect(userRow).toBeDefined();
  const userId: string = userRow?.id ?? "";
  expect(userId).not.toBe("");
  const rows = await db
    .select({ roleName: role.name })
    .from(principal)
    .innerJoin(principalRole, eq(principalRole.principalId, principal.id))
    .innerJoin(role, eq(role.id, principalRole.roleId))
    .where(
      and(
        eq(principal.tenantId, args.tenantId),
        eq(principal.kind, "user"),
        eq(principal.refId, userId),
        eq(principal.status, "active"),
      ),
    );
  return rows.map((r) => r.roleName);
}

describeIfDb("signup genesis (CL-7578)", () => {
  test("a closed empty hub admits the first signup, which mints the root tenant as owner — no seed", async () => {
    const scratchUrl = scratchUrlFor("closed");
    await withScratchDatabase(scratchUrl, async () => {
      const { baseUrl, db } = await bootEmptyHub({
        scratchUrl,
        signupMode: "closed",
      });

      // The empty-hub exception: signup is closed, but zero users and
      // zero tenants means this caller is the genesis owner.
      const cookies = await signUp(baseUrl, {
        name: "Alice",
        email: "alice@example.com",
        password: "password123",
      });

      const probe = await provision(baseUrl, cookies);
      expect(probe.kind).toBe("needs-onboarding");

      const result = await provision(baseUrl, cookies, "Acme");
      expect(result.kind).toBe("provisioned");
      expect(result.tenantSlug).toBe("workbench");
      expect(result.seeded).toBe(false);
      expect(typeof result.tenantId).toBe("string");
      const tenantId = result.tenantId;

      const [userCount] = await db.select().from(userTable);
      expect(userCount).toBeDefined();
      const roots = await db
        .select()
        .from(tenant)
        .where(isNull(tenant.parentId));
      expect(roots).toHaveLength(1);
      expect(roots[0]?.slug).toBe("workbench");
      const rootId: string = roots[0]?.id ?? "";
      expect(rootId).not.toBe("");
      expect((await db.select().from(tenant)).length).toBe(1);

      expect(
        await roleNamesFor(db, {
          tenantId: rootId,
          email: "alice@example.com",
        }),
      ).toEqual(["owner"]);

      // No seed side effects: the genesis tenant carries no workflow
      // assets and no deployments.
      const assets = await fetch(
        `${baseUrl}/api/tenants/${tenantId}/assets?kind=workflow&inherited=false`,
        { headers: { cookie: cookies.join("; ") } },
      );
      expect(await assets.json()).toEqual([]);
      const deployments = await fetch(
        `${baseUrl}/api/tenants/${tenantId}/workflows/deployments`,
        { headers: { cookie: cookies.join("; ") } },
      );
      expect(await deployments.json()).toEqual([]);
    });
  }, 30_000);

  test("the second signup on an open hub joins the existing root as member, minting nothing", async () => {
    const scratchUrl = scratchUrlFor("open");
    await withScratchDatabase(scratchUrl, async () => {
      const { baseUrl, db } = await bootEmptyHub({
        scratchUrl,
        signupMode: "open",
      });

      const alice = await signUp(baseUrl, {
        name: "Alice",
        email: "alice@example.com",
        password: "password123",
      });
      const genesis = await provision(baseUrl, alice, "Acme");
      expect(genesis.kind).toBe("provisioned");
      expect(genesis.tenantSlug).toBe("workbench");

      const bob = await signUp(baseUrl, {
        name: "Bob",
        email: "bob@example.com",
        password: "password123",
      });
      // The join path needs no display name: a plain membership probe
      // is enough, because the root already exists.
      const joined = await provision(baseUrl, bob);
      expect(joined.kind).toBe("existing-member");
      expect(joined.tenantSlug).toBe("workbench");
      expect(joined.tenantId).toBe(genesis.tenantId);

      const tenants = await db.select().from(tenant);
      expect(tenants).toHaveLength(1);
      const tenantId: string = tenants[0]?.id ?? "";
      expect(tenantId).not.toBe("");
      expect((await db.select().from(userTable)).length).toBe(2);

      expect(
        await roleNamesFor(db, {
          tenantId,
          email: "alice@example.com",
        }),
      ).toEqual(["owner"]);
      expect(
        await roleNamesFor(db, {
          tenantId,
          email: "bob@example.com",
        }),
      ).toEqual(["member"]);
    });
  }, 30_000);

  test("an operator-removed member cannot self-rejoin on a closed hub", async () => {
    const scratchUrl = scratchUrlFor("rejoin");
    await withScratchDatabase(scratchUrl, async () => {
      const open = await bootEmptyHub({
        scratchUrl,
        signupMode: "open",
      });

      const alice = await signUp(open.baseUrl, {
        name: "Alice",
        email: "alice@example.com",
        password: "password123",
      });
      await provision(open.baseUrl, alice, "Acme");
      const bob = await signUp(open.baseUrl, {
        name: "Bob",
        email: "bob@example.com",
        password: "password123",
      });
      const joined = await provision(open.baseUrl, bob);
      expect(joined.kind).toBe("existing-member");

      // Operator removal: native removal deletes the member's
      // principal rows outright, leaving the account itself alive.
      const [bobRow] = await open.db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.email, "bob@example.com"))
        .limit(1);
      expect(bobRow).toBeDefined();
      await open.db.delete(principalRole).where(
        inArray(
          principalRole.principalId,
          open.db
            .select({ id: principal.id })
            .from(principal)
            .where(
              and(
                eq(principal.kind, "user"),
                eq(principal.refId, bobRow?.id ?? ""),
              ),
            ),
        ),
      );
      await open.db
        .delete(principal)
        .where(
          and(
            eq(principal.kind, "user"),
            eq(principal.refId, bobRow?.id ?? ""),
          ),
        );

      // The hub flips signup to closed and restarts on the same data.
      await open.stop();
      const closed = await bootEmptyHub({
        scratchUrl,
        signupMode: "closed",
      });

      const signIn = await fetch(`${closed.baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "bob@example.com",
          password: "password123",
        }),
      });
      expect(signIn.status).toBe(200);
      const sessionCookies = signIn.headers.getSetCookie();

      const res = await fetch(`${closed.baseUrl}/api/onboarding/provision`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookies.join("; "),
        },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("signup_not_allowed");

      // No principal was minted: the removal sticks.
      const [bobAfter] = await closed.db
        .select({ id: principal.id })
        .from(principal)
        .where(
          and(
            eq(principal.kind, "user"),
            eq(principal.refId, bobRow?.id ?? ""),
          ),
        )
        .limit(1);
      expect(bobAfter).toBeUndefined();
    });
  }, 30_000);
});
