// `listPluginsForTenant` resolves each connector through the chain-aware
// `GET /credentials/resolve/:name` route (never the tenant-local list
// route), so a stub fetch here stands in for that resolver — asserting the
// exact request shape and the three outcomes a resolved plugin can carry:
// connected locally, connected by inheritance, and not connected.

import { afterEach, describe, expect, test } from "bun:test";

import { listPluginsForTenant } from "./plugins";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(
  byName: Readonly<Record<string, Response | (() => Response)>>,
): void {
  globalThis.fetch = (async (input: string) => {
    const url = new URL(input, "https://workbench.test");
    const match = /\/credentials\/resolve\/([^/]+)$/.exec(url.pathname);
    const name = match === null ? null : decodeURIComponent(match[1] ?? "");
    const entry = name === null ? undefined : byName[name];
    if (entry === undefined) return new Response(null, { status: 404 });
    return typeof entry === "function" ? entry() : entry;
  }) as unknown as typeof fetch;
}

describe("listPluginsForTenant", () => {
  test("a credential owned by the requesting tenant resolves as this-workbench", async () => {
    stubFetch({
      GitHub: json({
        id: "cred_1",
        tenantId: "bench_1",
        name: "GitHub",
        status: "active",
      }),
    });

    const resolved = await listPluginsForTenant("bench_1");
    const github = resolved.find((entry) => entry.descriptor.id === "github");

    expect(github?.status).toBe("connected");
    expect(github?.provenance).toBe("this-workbench");
    expect(github?.credentialId).toBe("cred_1");
    expect(github?.credentialName).toBe("GitHub");
  });

  test("a credential owned by an ancestor tenant resolves as inherited", async () => {
    stubFetch({
      GitHub: json({
        id: "cred_1",
        tenantId: "root_tenant",
        name: "GitHub",
        status: "active",
      }),
    });

    const resolved = await listPluginsForTenant("bench_1");
    const github = resolved.find((entry) => entry.descriptor.id === "github");

    expect(github?.status).toBe("connected");
    expect(github?.provenance).toBe("inherited");
  });

  test("no credential anywhere in the chain (404) resolves as not connected", async () => {
    stubFetch({});

    const resolved = await listPluginsForTenant("bench_1");
    const github = resolved.find((entry) => entry.descriptor.id === "github");

    expect(github?.status).toBe("not_connected");
    expect(github?.provenance).toBeNull();
    expect(github?.credentialName).toBeNull();
  });

  test("a revoked credential reads the same as not connected", async () => {
    stubFetch({
      GitHub: json({
        id: "cred_1",
        tenantId: "bench_1",
        name: "GitHub",
        status: "revoked",
      }),
    });

    const resolved = await listPluginsForTenant("bench_1");
    const github = resolved.find((entry) => entry.descriptor.id === "github");

    expect(github?.status).toBe("not_connected");
    expect(github?.provenance).toBeNull();
  });

  test("an expired credential needs attention but keeps its provenance", async () => {
    stubFetch({
      GitHub: json({
        id: "cred_1",
        tenantId: "root_tenant",
        name: "GitHub",
        status: "expired",
      }),
    });

    const resolved = await listPluginsForTenant("bench_1");
    const github = resolved.find((entry) => entry.descriptor.id === "github");

    expect(github?.status).toBe("needs_attention");
    expect(github?.provenance).toBe("inherited");
  });

  test("never resolves granola-webhook — it has no Credential row to resolve", async () => {
    stubFetch({});

    const resolved = await listPluginsForTenant("bench_1");

    expect(
      resolved.some((entry) => entry.descriptor.id === "granola-webhook"),
    ).toBe(false);
  });
});
