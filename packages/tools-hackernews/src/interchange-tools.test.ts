import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { hackernews } from "./interchange-tools";

// The `interchange.tools` entry is the contract the sidecar loader
// imports and wires into the reactor: it must export an
// AnnotatedToolFactory whose bundle exposes the package's tools and
// upholds the ToolRunner dispatch contract (unknown names surface as
// isError rather than throwing).

const env = {} as BaseEnv;

describe("tools-hackernews interchange.tools entry", () => {
  test("exports a namespaced AnnotatedToolFactory", () => {
    expect(typeof hackernews).toBe("function");
    expect(hackernews.id).toBe("@workbench/tools-hackernews/hackernews");
    expect(hackernews.requires).toEqual([]);
  });

  test("the bundle exposes hackernews_search", () => {
    const bundle = hackernews(env);
    expect(bundle.definitions.map((d) => d.name)).toEqual([
      "hackernews_search",
    ]);
  });

  test("run surfaces an unknown tool as isError rather than throwing", async () => {
    const bundle = hackernews(env);
    const result = await bundle.run(
      { id: "call-1", name: "not_a_tool", arguments: {} },
      AbortSignal.timeout(1000),
    );
    expect(result.isError).toBe(true);
  });
});
