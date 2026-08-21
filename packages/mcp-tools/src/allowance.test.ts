import { describe, expect, test } from "bun:test";

import type { McpToolInfo } from "./mcp-client";
import { createMcpCallClassifier, mcpServerResource } from "./allowance";

const TOOLS: readonly McpToolInfo[] = [
  {
    name: "search_records",
    description: "Searches records",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_record",
    description: "Creates a record",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: false },
  },
];

const classify = createMcpCallClassifier((_tenantId, slug) =>
  Promise.resolve(slug === "attio" ? TOOLS : null),
);

describe("createMcpCallClassifier", () => {
  test("a server-verified read-only tool classifies with the connection resource", async () => {
    expect(
      await classify("tenant_1", { server: "attio", tool: "search_records" }),
    ).toEqual({ readOnly: true, resource: mcpServerResource("attio") });
  });

  test("a write tool classifies not read-only", async () => {
    expect(
      await classify("tenant_1", { server: "attio", tool: "create_record" }),
    ).toEqual({ readOnly: false });
  });

  test("an unknown downstream tool fails closed", async () => {
    expect(
      await classify("tenant_1", { server: "attio", tool: "drop_everything" }),
    ).toEqual({ readOnly: false });
  });

  test("an unreachable or unconnected server fails closed", async () => {
    expect(
      await classify("tenant_1", { server: "ghost", tool: "search_records" }),
    ).toEqual({ readOnly: false });
  });

  test("malformed arguments fail closed", async () => {
    expect(await classify("tenant_1", { server: 7 })).toEqual({
      readOnly: false,
    });
  });
});

// The GitHub MCP preset promises nothing beyond this live check: reads
// (search, get file, list PRs) ride a grant only when GitHub's own
// tools/list marks them read-only; writes (create issue, merge) and
// unannotated tools always stay parked.
describe("GitHub MCP server classification", () => {
  const githubTools: readonly McpToolInfo[] = [
    {
      name: "search_code",
      description: "Search code across repositories",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_file_contents",
      description: "Get file contents",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    {
      name: "list_pull_requests",
      description: "List pull requests",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_issue",
      description: "Create an issue",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: false },
    },
    {
      name: "merge_pull_request",
      description: "Merge a pull request",
      inputSchema: { type: "object" },
    },
  ];

  const classifyGithub = createMcpCallClassifier((_tenantId, slug) =>
    Promise.resolve(slug === "github-mcp" ? githubTools : null),
  );

  test("server-annotated reads classify read-only on the github-mcp resource", async () => {
    for (const tool of [
      "search_code",
      "get_file_contents",
      "list_pull_requests",
    ]) {
      expect(
        await classifyGithub("tenant_1", { server: "github-mcp", tool }),
      ).toEqual({ readOnly: true, resource: mcpServerResource("github-mcp") });
    }
  });

  test("writes and unannotated tools never classify read-only", async () => {
    for (const tool of ["create_issue", "merge_pull_request"]) {
      expect(
        await classifyGithub("tenant_1", { server: "github-mcp", tool }),
      ).toEqual({ readOnly: false });
    }
  });
});
