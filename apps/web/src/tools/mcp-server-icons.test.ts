import { describe, expect, test } from "bun:test";

import { MCP_SERVER_CATALOG } from "@corbits/worker/workflow-ids";
import { Captions, GitPullRequest, MagnifyingGlass, Plugs } from "@/lib/icons";

import { mcpServerIcon } from "./mcp-server-icons";

describe("mcpServerIcon", () => {
  test("popular servers wear their own mark", () => {
    expect(mcpServerIcon("exa")).toBe(MagnifyingGlass);
    expect(mcpServerIcon("linear")).toBe(GitPullRequest);
    expect(mcpServerIcon("granola")).toBe(Captions);
  });

  test("unknown handles fall back to the plugs mark", () => {
    expect(mcpServerIcon("some-custom-server")).toBe(Plugs);
    expect(mcpServerIcon("")).toBe(Plugs);
  });

  test("every platform catalog entry has its own mark", () => {
    for (const entry of MCP_SERVER_CATALOG) {
      expect(mcpServerIcon(entry.handle)).not.toBe(Plugs);
    }
  });
});
