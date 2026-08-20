import { expect, test } from "bun:test";

import { listConnections, type ConnectionsToolClientConfig } from "./client";

function testConfig(fetchImpl: typeof fetch): ConnectionsToolClientConfig {
  return {
    hubConnectionsUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("listConnections fetches the workflow-connections endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "granola",
            displayName: "Granola",
            docsUrl: "https://www.granola.ai",
            connected: true,
          },
        ],
      }),
    );
  }) as unknown as typeof fetch;

  const connections = await listConnections(testConfig(fetchImpl));

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-connections/connections",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  expect(connections).toEqual([
    {
      id: "granola",
      displayName: "Granola",
      docsUrl: "https://www.granola.ai",
      connected: true,
    },
  ]);
});

test("listConnections throws an honest error on a non-ok HTTP response, never fabricating a result", async () => {
  const fetchImpl = (async () =>
    new Response("", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  await expect(listConnections(testConfig(fetchImpl))).rejects.toThrow(/500/);
});

test("listConnections throws on a response that doesn't match the expected shape", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ nonsense: true }),
    )) as unknown as typeof fetch;

  await expect(listConnections(testConfig(fetchImpl))).rejects.toThrow(
    /expected shape/,
  );
});

test("listConnections throws an honest error when the hub is unreachable", async () => {
  const fetchImpl = (async () => {
    throw new Error("fetch failed: connection refused");
  }) as unknown as typeof fetch;

  await expect(listConnections(testConfig(fetchImpl))).rejects.toThrow(
    /connection refused/,
  );
});
