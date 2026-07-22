import { describe, expect, test } from "bun:test";
import { assertCatalogDescriptionStyle } from "./catalog-style";
import { loadCommittedToolManifestFactories } from "./committed-index";
import type { ToolFactoryManifest } from "./schema";

function factory(
  overrides: Partial<ToolFactoryManifest> &
    Pick<ToolFactoryManifest, "factoryId">,
): ToolFactoryManifest {
  return {
    packageName: "@workbench/tools-example",
    bareToolNames: ["example_tool"],
    sideEffects: { example_tool: "read" },
    ...overrides,
  };
}

describe("assertCatalogDescriptionStyle", () => {
  test("passes real committed catalog descriptions", () => {
    expect(() =>
      assertCatalogDescriptionStyle(loadCommittedToolManifestFactories()),
    ).not.toThrow();
  });

  test("rejects an empty myraCatalog summary", () => {
    const factories = [
      factory({
        factoryId: "a",
        myraCatalog: { catalogPackage: "example", summary: "  ", tags: [] },
      }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).toThrow(
      /must not be empty/,
    );
  });

  test("rejects an empty per-tool description", () => {
    const factories = [
      factory({ factoryId: "a", descriptions: { example_tool: "" } }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).toThrow(
      /must not be empty/,
    );
  });

  test("rejects a banned marketing phrase in a summary", () => {
    const factories = [
      factory({
        factoryId: "a",
        myraCatalog: {
          catalogPackage: "example",
          summary: "A powerful way to search things.",
          tags: [],
        },
      }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).toThrow(
      /banned phrase "powerful"/,
    );
  });

  test("rejects a banned marketing phrase in a per-tool description", () => {
    const factories = [
      factory({
        factoryId: "a",
        descriptions: { example_tool: "Easily search example records." },
      }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).toThrow(
      /banned phrase "easily"/,
    );
  });

  test("rejects a myraCatalog summary over the length ceiling", () => {
    const factories = [
      factory({
        factoryId: "a",
        myraCatalog: {
          catalogPackage: "example",
          summary: "x".repeat(221),
          tags: [],
        },
      }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).toThrow(
      /exceeds 220 chars/,
    );
  });

  test("allows a long per-tool description (disambiguation is a human call, not a length cap)", () => {
    const factories = [
      factory({
        factoryId: "a",
        descriptions: { example_tool: "x".repeat(1000) },
      }),
    ];
    expect(() => assertCatalogDescriptionStyle(factories)).not.toThrow();
  });

  test("reports every violation, not just the first", () => {
    const factories = [
      factory({
        factoryId: "a",
        myraCatalog: { catalogPackage: "example", summary: "", tags: [] },
        descriptions: { example_tool: "" },
      }),
    ];
    try {
      assertCatalogDescriptionStyle(factories);
      throw new Error("expected assertCatalogDescriptionStyle to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("myraCatalog.summary");
      expect(message).toContain("descriptions.example_tool");
    }
  });
});
