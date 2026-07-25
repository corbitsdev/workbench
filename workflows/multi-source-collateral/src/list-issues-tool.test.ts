import { describe, expect, it, mock } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION,
  createMultiSourceCollateralListIssuesTools,
} from "./list-issues-tool";
import { toolManifestFile } from "./tool-manifest";

const SIGNAL = new AbortController().signal;

function findTool(
  env: Parameters<typeof createMultiSourceCollateralListIssuesTools>[0],
) {
  const tool = createMultiSourceCollateralListIssuesTools(env).find(
    (t) =>
      t.definition.name === MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION.name,
  );
  if (!tool || tool.kind !== "full") {
    throw new Error("multi_source_collateral_list_issues not registered");
  }
  return tool;
}

describe("multi_source_collateral_list_issues", () => {
  it("returns a completed error envelope (not a throw) when Linear is unconfigured", async () => {
    const env = {} as unknown as Parameters<
      typeof createMultiSourceCollateralListIssuesTools
    >[0];
    const tool = findTool(env);
    const result = await tool.handler(
      { id: "call_1", name: tool.definition.name, arguments: { first: 50 } },
      SIGNAL,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ isError: true });
  });

  it("returns a completed error envelope (not a throw) when the Linear API call fails", async () => {
    const env = {
      [toolCredentialEnvKey("linear")]: {
        apiKey: "linear-key",
        baseURL: "",
      },
    } as unknown as Parameters<
      typeof createMultiSourceCollateralListIssuesTools
    >[0];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    ) as unknown as typeof fetch;
    try {
      const tool = findTool(env);
      const result = await tool.handler(
        { id: "call_2", name: tool.definition.name, arguments: { first: 50 } },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toMatchObject({ isError: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("tool-manifest", () => {
  it("registers the list-issues wrapper tool under its own factory", () => {
    const factory = toolManifestFile.factories.find(
      (f) =>
        f.factoryId ===
        "@workbench/workflow-multi-source-collateral/list-issues",
    );
    expect(factory?.bareToolNames).toEqual([
      MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION.name,
    ]);
  });
});
