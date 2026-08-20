import { expect, test } from "bun:test";

import { parseMcpFakeRecording } from "./recording.ts";

const valid = {
  server: "github",
  tools: [
    {
      name: "list_pull_requests",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  calls: [
    {
      tool: "list_pull_requests",
      arguments: { owner: "acme-corp" },
      response: { isError: false, content: "ok" },
    },
  ],
};

test("parses a well-formed recording", () => {
  const parsed = parseMcpFakeRecording(valid);
  expect(parsed.server).toBe("github");
  expect(parsed.calls).toHaveLength(1);
});

test("rejects a recording missing required fields", () => {
  expect(() => parseMcpFakeRecording({ server: "github" })).toThrow(
    /invalid MCP fake recording/,
  );
});

test("rejects a call whose response is missing isError", () => {
  const broken = {
    ...valid,
    calls: [
      { tool: "list_pull_requests", arguments: {}, response: { content: "x" } },
    ],
  };
  expect(() => parseMcpFakeRecording(broken)).toThrow(
    /invalid MCP fake recording/,
  );
});
