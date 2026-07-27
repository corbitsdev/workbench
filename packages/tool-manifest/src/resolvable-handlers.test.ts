import { describe, expect, test } from "bun:test";
import { loadCommittedToolManifestFactories } from "./committed-index";
import {
  assertHandlersResolveToTools,
  collectAllWorkflowHandlers,
  loadCommittedWorkflowDefs,
} from "./resolvable-handlers";

describe("assertHandlersResolveToTools", () => {
  test("every committed workflow def's action handlers resolve to a real tool", () => {
    const defs = loadCommittedWorkflowDefs();
    expect(defs.length).toBeGreaterThan(0);
    const handlers = collectAllWorkflowHandlers(defs);
    expect(handlers.size).toBeGreaterThan(0);
    expect(() =>
      assertHandlersResolveToTools(
        handlers,
        loadCommittedToolManifestFactories(),
      ),
    ).not.toThrow();
  });

  test("a typo'd handler string fails the check", () => {
    const factories = loadCommittedToolManifestFactories();
    const handlers = new Set([
      "@workbench/tools-exa/exa:exa_search",
      "@workbench/tools-exa/exa:exa_serach",
    ]);
    expect(() => assertHandlersResolveToTools(handlers, factories)).toThrow(
      /exa_serach/,
    );
  });

  test("a retired-factory handler string fails the check", () => {
    const factories = loadCommittedToolManifestFactories();
    const handlers = new Set(["@workbench/tools-nonexistent/core:some_tool"]);
    expect(() => assertHandlersResolveToTools(handlers, factories)).toThrow(
      /tools-nonexistent/,
    );
  });

  test("collectAllWorkflowHandlers finds handlers nested inside step actions", () => {
    const def = {
      definition: {
        steps: {
          fetch: {
            kind: "action",
            handler: "@workbench/tools-exa/exa:exa_search",
            effect: { requires: ["@workbench/tools-exa/exa:exa_search"] },
          },
        },
      },
    };
    const handlers = collectAllWorkflowHandlers([def]);
    expect(handlers.has("@workbench/tools-exa/exa:exa_search")).toBe(true);
  });
});
