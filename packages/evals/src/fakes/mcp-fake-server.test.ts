import { afterEach, expect, test } from "bun:test";
import {
  callMcpTool,
  listMcpTools,
  withMcpConnection,
} from "@corbits/mcp-tools";

import githubFixture from "./recordings/github.json";
import { parseMcpFakeRecording } from "./recording.ts";
import { startMcpFake, type McpFakeHandle } from "./mcp-fake-server.ts";

const recording = parseMcpFakeRecording(githubFixture);

let handle: McpFakeHandle | undefined;

afterEach(() => {
  handle?.stop();
  handle = undefined;
});

test("tools/list surfaces exactly the fixture's tools", async () => {
  handle = startMcpFake(recording);
  const tools = await withMcpConnection(
    { url: handle.url, fetchImpl: fetch },
    (client) => listMcpTools(client),
  );
  expect(tools.map((tool) => tool.name)).toEqual(["list_pull_requests"]);
});

test("tools/call replays the recorded response and logs a receipt", async () => {
  handle = startMcpFake(recording);
  const result = await withMcpConnection(
    { url: handle.url, fetchImpl: fetch },
    (client) =>
      callMcpTool(client, {
        name: "list_pull_requests",
        arguments: { owner: "acme-corp", repo: "widget-service" },
      }),
  );
  expect(result.isError).toBe(false);
  expect(JSON.stringify(result.content)).toContain("Fix flaky checkout test");
  expect(handle.receipts()).toEqual([
    {
      server: "github",
      toolName: "list_pull_requests",
      arguments: { owner: "acme-corp", repo: "widget-service" },
    },
  ]);
});

test("an unrecorded call fails loudly instead of silently defaulting", async () => {
  handle = startMcpFake(recording);
  await expect(
    withMcpConnection({ url: handle.url, fetchImpl: fetch }, (client) =>
      callMcpTool(client, {
        name: "list_pull_requests",
        arguments: { owner: "someone-else", repo: "unknown-repo" },
      }),
    ),
  ).rejects.toThrow(/No recorded call for github\.list_pull_requests/);
  expect(handle.receipts()).toEqual([]);
});

test("argument key order does not affect matching", async () => {
  handle = startMcpFake(recording);
  const result = await withMcpConnection(
    { url: handle.url, fetchImpl: fetch },
    (client) =>
      callMcpTool(client, {
        name: "list_pull_requests",
        arguments: { repo: "widget-service", owner: "acme-corp" },
      }),
  );
  expect(result.isError).toBe(false);
});
