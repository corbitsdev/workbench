import { afterEach, describe, expect, test } from "bun:test";

import { fetchGranolaPluginConnected } from "./granola-plugin-availability";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchGranolaPluginConnected", () => {
  test("false on 404 — Granola not connected", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await fetchGranolaPluginConnected("tnt_1")).toBe(false);
  });

  test("true when the resolved credential is active", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "cred_1",
          tenantId: "tnt_1",
          name: "Granola",
          status: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    expect(await fetchGranolaPluginConnected("tnt_1")).toBe(true);
  });

  test("true when the credential needs attention (expired/error)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "cred_1",
          tenantId: "tnt_1",
          name: "Granola",
          status: "expired",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    expect(await fetchGranolaPluginConnected("tnt_1")).toBe(true);
  });

  test("false when the credential is revoked", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "cred_1",
          tenantId: "tnt_1",
          name: "Granola",
          status: "revoked",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    expect(await fetchGranolaPluginConnected("tnt_1")).toBe(false);
  });

  test("false on network failure — never claim connected", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchGranolaPluginConnected("tnt_1")).toBe(false);
  });
});
