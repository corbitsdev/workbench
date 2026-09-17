import { expect, test } from "bun:test";

import {
  listConnectedProviders,
  type ConnectionsToolClientConfig,
} from "./client";

function testConfig(fetchImpl: typeof fetch): ConnectionsToolClientConfig {
  return {
    hubConnectionsUrl: "https://hub.example.com",
    tenantId: "ten_1",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

/** Stock providers + credentials, keyed so only `granola` has a live
 * credential: `linear`'s is revoked and `exa` has none at all. */
function stockHub(): {
  fetchImpl: typeof fetch;
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    headers.push(init?.headers as Record<string, string>);
    if (String(url).includes("/providers")) {
      return Response.json({
        data: [
          { id: "prv_1", name: "granola" },
          { id: "prv_2", name: "linear" },
          { id: "prv_3", name: "exa" },
        ],
        nextCursor: null,
      });
    }
    return Response.json({
      data: [
        { id: "crd_1", providerId: "prv_1", status: "active" },
        { id: "crd_2", providerId: "prv_2", status: "revoked" },
      ],
      nextCursor: null,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, headers };
}

test("a connector counts as connected only with an active credential against its own provider", async () => {
  const { fetchImpl, urls, headers } = stockHub();

  const live = await listConnectedProviders(testConfig(fetchImpl));

  expect([...live]).toEqual(["granola"]);
  expect(
    urls.some((u) =>
      u.startsWith("https://hub.example.com/api/tenants/ten_1/providers?"),
    ),
  ).toBe(true);
  expect(
    urls.some((u) =>
      u.startsWith("https://hub.example.com/api/tenants/ten_1/credentials?"),
    ),
  ).toBe(true);
  expect(headers[0]?.["authorization"]).toBe("Bearer sc-token");
  expect(headers[0]?.["x-workflow-run-address"]).toBe("run_1@workflow");
});

test("a credential past the first page still counts as connected", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const raw = String(url);
    if (raw.includes("/providers")) {
      return Response.json({
        data: [{ id: "prv_9", name: "granola" }],
        nextCursor: null,
      });
    }
    if (raw.includes("cursor=page_2")) {
      return Response.json({
        data: [{ id: "crd_2", providerId: "prv_9", status: "active" }],
        nextCursor: null,
      });
    }
    return Response.json({
      data: [{ id: "crd_1", providerId: "prv_other", status: "active" }],
      nextCursor: "page_2",
    });
  }) as unknown as typeof fetch;

  expect([...(await listConnectedProviders(testConfig(fetchImpl)))]).toEqual([
    "granola",
  ]);
});

test("a non-ok HTTP response throws honestly, never fabricating a result", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(listConnectedProviders(testConfig(fetchImpl))).rejects.toThrow(
    /500/,
  );
});

test("a response that doesn't match the expected shape throws", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ nonsense: true }),
    )) as unknown as typeof fetch;

  await expect(listConnectedProviders(testConfig(fetchImpl))).rejects.toThrow(
    /unexpected shape/,
  );
});

test("an unreachable hub throws honestly", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;

  await expect(listConnectedProviders(testConfig(fetchImpl))).rejects.toThrow(
    /connection refused/,
  );
});
