// Walks the Settings roles flow over stock routes: create a role, target a
// grant at it, assign it to a person AND to an agent principal, then prove
// both evaluations allow while an unassigned member stays denied. The agent
// principal is seeded straight into the database to stand in for first-run
// minting (agent/workflow principals only exist after their first run, never
// at deploy time), and the closing 404s pin the contract the Settings
// assignment picker keys its first-run guidance off.

import { afterAll, expect, test } from "bun:test";
import { type } from "arktype";

import { createDB } from "@intx/db";
import { principal } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";
import { bootHub } from "../lib/hub";
import { cleanupTenants } from "../lib/tenant-cleanup";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

function dbConfigFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

const Id = type({ id: "string" });
const Evaluation = type({
  effect: "string",
  matchingGrants: type({ id: "string" }).array(),
});
const PrincipalDetail = type({
  id: "string",
  kind: "string",
  roles: type({ id: "string", name: "string" }).array(),
});
const PrincipalPage = type({
  data: type({ id: "string", kind: "string" }).array(),
});

describeIfDb("settings roles flow allows people and agents alike", () => {
  const booted = bootHub();
  const closers: (() => Promise<void>)[] = [];
  const seededTenantIds: string[] = [];
  afterAll(async () => {
    for (const close of closers) await close();
    await cleanupTenants(seededTenantIds);
  });

  test("create-role, grant, assign (person and agent), evaluate", async () => {
    if (databaseUrl === undefined) return;
    const hub = booted();
    const origin = "http://localhost";
    const suffix = crypto.randomUUID().slice(0, 8);
    const resource = "billing:invoice";
    const action = "refund";

    async function call(path: string, cookie: string, method = "GET", body?: unknown) {
      return hub.fetch(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            origin,
            ...(cookie !== "" ? { cookie } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      );
    }

    async function signUp(name: string): Promise<{ email: string; cookie: string }> {
      const email = `${name}-${suffix}@example.com`;
      const res = await call("/api/auth/sign-up/email", "", "POST", {
        email,
        password: "password123",
        name,
      });
      expect(res.status).toBe(200);
      const cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      return { email, cookie };
    }

    async function created(res: Response): Promise<string> {
      expect(res.status).toBe(201);
      return Id.assert(await res.json()).id;
    }

    const alice = await signUp("alice");
    const bob = await signUp("bob");
    const charlie = await signUp("charlie");

    // Settings "New role" dialog.
    const tenant = await created(
      await call("/api/tenants", alice.cookie, "POST", {
        name: "Workspace",
        slug: `ws-${suffix}`,
      }),
    );
    seededTenantIds.push(tenant);
    const role = await created(
      await call(`/api/tenants/${tenant}/roles`, alice.cookie, "POST", {
        name: `Billing ${suffix}`,
        description: "May refund billing invoices",
      }),
    );

    // Settings "New rule" dialog targeting the role.
    const grant = await created(
      await call(`/api/tenants/${tenant}/grants`, alice.cookie, "POST", {
        roleId: role,
        resource,
        action,
        effect: "allow",
        origin: "role",
      }),
    );

    // Person leg: invite Bob, assign the role, prove the grant reaches him.
    const bobPrincipal = await created(
      await call(`/api/tenants/${tenant}/members/invite`, alice.cookie, "POST", {
        email: bob.email,
      }),
    );
    expect(
      (
        await call(
          `/api/tenants/${tenant}/principals/${bobPrincipal}/roles/${role}`,
          alice.cookie,
          "POST",
        )
      ).status,
    ).toBe(204);

    const bobDetail = await call(`/api/tenants/${tenant}/principals/${bobPrincipal}`, alice.cookie);
    expect(bobDetail.status).toBe(200);
    expect(PrincipalDetail.assert(await bobDetail.json()).roles.map((r) => r.id)).toContain(role);

    // Agent leg: the run path mints this row on first delivery; the test
    // stands that minting in directly, then drives the same assignment and
    // evaluation routes the Settings picker uses.
    const agentPrincipal = generateId("principal");
    const handle = createDB(dbConfigFromUrl(databaseUrl));
    closers.push(handle.close);
    await handle.db.insert(principal).values({
      id: agentPrincipal,
      tenantId: tenant,
      kind: "workflow",
      refId: generateId("workflowRun"),
      status: "active",
    });
    expect(
      (
        await call(
          `/api/tenants/${tenant}/principals/${agentPrincipal}/roles/${role}`,
          alice.cookie,
          "POST",
        )
      ).status,
    ).toBe(204);

    // The assignment picker reads the tenant-wide principal list, so the
    // minted agent principal must show up there next to people.
    const listed = await call(`/api/tenants/${tenant}/principals?kind=workflow`, alice.cookie);
    expect(listed.status).toBe(200);
    expect(PrincipalPage.assert(await listed.json()).data.map((p) => p.id)).toContain(
      agentPrincipal,
    );

    async function effectOf(principalId: string) {
      const res = await call(
        `/api/tenants/${tenant}/principals/${principalId}/evaluate`,
        alice.cookie,
        "POST",
        { resource, action },
      );
      expect(res.status).toBe(200);
      return Evaluation.assert(await res.json());
    }

    const bobResult = await effectOf(bobPrincipal);
    expect(bobResult.effect).toBe("allow");
    expect(bobResult.matchingGrants.map((g) => g.id)).toContain(grant);

    const agentResult = await effectOf(agentPrincipal);
    expect(agentResult.effect).toBe("allow");
    expect(agentResult.matchingGrants.map((g) => g.id)).toContain(grant);

    // Fail-closed control: an invited member holding no role is denied.
    const charliePrincipal = await created(
      await call(`/api/tenants/${tenant}/members/invite`, alice.cookie, "POST", {
        email: charlie.email,
      }),
    );
    const charlieResult = await effectOf(charliePrincipal);
    expect(charlieResult.effect).toBe("deny");
    expect(charlieResult.matchingGrants).toEqual([]);

    // The 404 contract the assignment picker's first-run guidance keys off:
    // a principal that was never minted (no first run yet) is "not found",
    // not a transient failure.
    const ghost = `principal_ghost_${suffix}`;
    expect(
      (await call(`/api/tenants/${tenant}/principals/${ghost}/roles/${role}`, alice.cookie, "POST"))
        .status,
    ).toBe(404);
    expect(
      (
        await call(`/api/tenants/${tenant}/principals/${ghost}/evaluate`, alice.cookie, "POST", {
          resource,
          action,
        })
      ).status,
    ).toBe(404);
  }, 180_000);
});
