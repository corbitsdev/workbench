// The sidecar-placement API client, tested the same way tenancy-api.test.ts
// tests its own client: stub global fetch, call the exported function,
// assert both the request it made and how it parses the response.
import { afterEach, expect, test } from "bun:test";

import {
  getSidecarPlacement,
  setSidecarPlacement,
  SidecarPlacementApiError,
} from "../src/sidecar-placement-api";

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

test("getSidecarPlacement GETs the tenant's route and parses the result", async () => {
  const calls = stubFetch(() =>
    Response.json({ enabled: true, provisionerAvailable: true }),
  );
  const result = await getSidecarPlacement("tnt_1");
  expect(result).toEqual({ enabled: true, provisionerAvailable: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.path).toBe("/api/tenants/tnt_1/sidecar-placement");
});

test("setSidecarPlacement PUTs enabled and parses the result", async () => {
  const calls = stubFetch(() =>
    Response.json({ enabled: false, provisionerAvailable: true }),
  );
  const result = await setSidecarPlacement("tnt_1", false);
  expect(result).toEqual({ enabled: false, provisionerAvailable: true });
  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call?.init?.method).toBe("PUT");
  expect(call?.init?.body).toBe(JSON.stringify({ enabled: false }));
});

test("getSidecarPlacement reports provisionerAvailable: false when the hub has none configured", async () => {
  const calls = stubFetch(() =>
    Response.json({ enabled: false, provisionerAvailable: false }),
  );
  const result = await getSidecarPlacement("tnt_1");
  expect(result).toEqual({ enabled: false, provisionerAvailable: false });
  expect(calls).toHaveLength(1);
});

test("a non-ok response throws SidecarPlacementApiError with the status", async () => {
  stubFetch(() => new Response("forbidden", { status: 403 }));
  await expect(getSidecarPlacement("tnt_1")).rejects.toBeInstanceOf(
    SidecarPlacementApiError,
  );
});

test("a malformed response body throws rather than returning garbage", async () => {
  stubFetch(() => Response.json({ enabled: "yes", provisionerAvailable: true }));
  await expect(getSidecarPlacement("tnt_1")).rejects.toBeInstanceOf(
    SidecarPlacementApiError,
  );
});
