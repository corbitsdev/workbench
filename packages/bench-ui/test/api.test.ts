// The remaining bench-ui HTTP client: listWorkbenchTenantIds. Stub global
// fetch, call the export, assert the request and the parsed set.

import { afterEach, describe, expect, test } from "bun:test";

import { listWorkbenchTenantIds } from "../src/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listWorkbenchTenantIds", () => {
  test("posts the tenant ids and returns them as a set", async () => {
    const calls = stubFetch(() => json({ workbenchTenantIds: ["tnt_2"] }));
    const result = await listWorkbenchTenantIds(["tnt_1", "tnt_2"]);
    expect(calls[0]?.path).toBe("/api/workbench-tenancies/kinds");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      tenantIds: ["tnt_1", "tnt_2"],
    });
    expect(result).toEqual(new Set(["tnt_2"]));
  });

  test("never round-trips for an empty request", async () => {
    const calls = stubFetch(() => json({ workbenchTenantIds: [] }));
    const result = await listWorkbenchTenantIds([]);
    expect(calls).toHaveLength(0);
    expect(result).toEqual(new Set());
  });
});
