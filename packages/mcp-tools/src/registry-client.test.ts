import { expect, test } from "bun:test";

import { listMcpServers } from "./registry-client";

test("lists connected MCP servers, sending the workflow-run auth headers", async () => {
  let received: { url: string; headers: Record<string, string> } | undefined;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    received = {
      url: input.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    return new Response(
      JSON.stringify({
        data: [
          { slug: "notion", name: "Notion", url: "https://notion.example/mcp" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const servers = await listMcpServers({
    hubConnectionsUrl: "https://hub.internal",
    sidecarToken: "tok",
    address: "run-1@workbench",
    fetchImpl,
  });

  expect(servers).toEqual([
    { slug: "notion", name: "Notion", url: "https://notion.example/mcp" },
  ]);
  expect(received?.url).toBe(
    "https://hub.internal/api/workflow-connections/mcp-servers",
  );
  expect(received?.headers["authorization"]).toBe("Bearer tok");
  expect(received?.headers["x-workflow-run-address"]).toBe("run-1@workbench");
});

test("throws on a non-ok response", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response("nope", { status: 500 }),
    )) as unknown as typeof fetch;
  await expect(
    listMcpServers({
      hubConnectionsUrl: "https://hub.internal",
      sidecarToken: "tok",
      address: "run-1@workbench",
      fetchImpl,
    }),
  ).rejects.toThrow(/500/);
});

test("throws on a malformed response body", async () => {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )) as unknown as typeof fetch;
  await expect(
    listMcpServers({
      hubConnectionsUrl: "https://hub.internal",
      sidecarToken: "tok",
      address: "run-1@workbench",
      fetchImpl,
    }),
  ).rejects.toThrow(/did not match/);
});
