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
