// Proves the tenant-tree rule over stock routes: credentials resolve down
// from an ancestor tenant, grants never do. Booting the hub runs package
// migrations, so the suite skips without a reachable DATABASE_URL.

import { afterAll, expect, test } from "bun:test";
import { type } from "arktype";
import { dbGate } from "../lib/db-gate";
import { installDisposableHubDataDir } from "../lib/disposable-hub-data-dir";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

installDisposableHubDataDir();
process.env["CREDENTIAL_ENCRYPTION_KEY"] ??= "0".repeat(64);
process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"] ??= "1".repeat(64);
process.env["SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] ??= "2".repeat(64);
if (databaseUrl !== "") {
  const url = new URL(databaseUrl);
  process.env["DB_HOST"] = url.hostname;
  process.env["DB_PORT"] = url.port === "" ? "5432" : url.port;
  process.env["DB_USER"] = decodeURIComponent(url.username);
  process.env["DB_PASSWORD"] = decodeURIComponent(url.password);
  process.env["DB_NAME"] = url.pathname.replace(/^\//, "");
}

// A hub left running keeps reconciling the shared database and fails the
// allocations of every hub booted after it in the same process.
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

const Id = type({ id: "string" });
const GrantPage = type({ data: type({ id: "string" }).array() });
const Evaluation = type({ effect: "string", matchingGrants: type({ id: "string" }).array() });

describeIfDb("grants are explicit per tenant", () => {
  test("a credential resolves from a child tenant; a grant does not", async () => {
    const { createHubServer } = await import("../../apps/hub/src/server");
    const hub = await createHubServer();
    closers.push(() => hub.shutdown());
    const origin = "http://localhost";
    const suffix = crypto.randomUUID().slice(0, 8);

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

    async function created(res: Response) {
      expect(res.status).toBe(201);
      return Id.assert(await res.json()).id;
    }

    const alice = await signUp("alice");
    const bob = await signUp("bob");

    const workspace = await created(
      await call("/api/tenants", alice.cookie, "POST", {
        name: "Workspace",
        slug: `ws-${suffix}`,
      }),
    );
    const bench = await created(
      await call("/api/tenants", alice.cookie, "POST", {
        name: "Bench",
        slug: `bench-${suffix}`,
        parentId: workspace,
      }),
    );

    // Bob is a member of both tenants with no role: his only authority is
    // whatever grant is assigned to his principal in that tenant.
    const bobInWorkspace = await created(
      await call(`/api/tenants/${workspace}/members/invite`, alice.cookie, "POST", {
        email: bob.email,
      }),
    );
    const bobInBench = await created(
      await call(`/api/tenants/${bench}/members/invite`, alice.cookie, "POST", {
        email: bob.email,
      }),
    );

    // Credentials walk down the tree.
    const provider = await created(
      await call(`/api/tenants/${workspace}/providers`, alice.cookie, "POST", {
        name: "example",
        plugin: "example",
      }),
    );
    const credential = await created(
      await call(`/api/tenants/${workspace}/credentials`, alice.cookie, "POST", {
        providerId: provider,
        name: "shared-key",
        type: "api_key",
        secret: "not-a-real-secret",
      }),
    );
    const resolved = await call(
      `/api/tenants/${bench}/credentials/resolve/shared-key`,
      alice.cookie,
    );
    expect(resolved.status).toBe(200);
    expect(Id.assert(await resolved.json()).id).toBe(credential);

    // A grant assigned to bob's workspace principal is effective there.
    await created(
      await call(`/api/tenants/${workspace}/grants`, alice.cookie, "POST", {
        principalId: bobInWorkspace,
        resource: "credential:*",
        action: "use",
        effect: "allow",
        origin: "role",
      }),
    );
    const evaluate = (tenant: string, principal: string) =>
      call(`/api/tenants/${tenant}/principals/${principal}/evaluate`, alice.cookie, "POST", {
        resource: `credential:${credential}`,
        action: "use",
      });
    const inWorkspace = await evaluate(workspace, bobInWorkspace);
    expect(inWorkspace.status).toBe(200);
    expect(Evaluation.assert(await inWorkspace.json()).effect).toBe("allow");

    // It is not effective in the child: the child lists no such grant, bob's
    // child principal is denied, and the workspace principal is unknown there.
    const listed = await call(
      `/api/tenants/${bench}/grants?principalId=${bobInWorkspace}`,
      alice.cookie,
    );
    expect(listed.status).toBe(200);
    expect(GrantPage.assert(await listed.json()).data).toEqual([]);

    const inBench = await evaluate(bench, bobInBench);
    expect(inBench.status).toBe(200);
    const benchResult = Evaluation.assert(await inBench.json());
    expect(benchResult.effect).toBe("deny");
    expect(benchResult.matchingGrants).toEqual([]);

    expect((await evaluate(bench, bobInWorkspace)).status).toBe(404);
  });
});
