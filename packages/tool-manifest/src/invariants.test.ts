import { describe, expect, test } from "bun:test";
import { assertToolManifestFactoryInvariants } from "./invariants";
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

describe("assertToolManifestFactoryInvariants", () => {
  test("rejects duplicate bare tool names across factories", () => {
    const factories = [
      factory({
        factoryId: "a",
        bareToolNames: ["dup"],
        sideEffects: { dup: "read" },
      }),
      factory({
        factoryId: "b",
        bareToolNames: ["dup"],
        sideEffects: { dup: "write" },
      }),
    ];
    expect(() => assertToolManifestFactoryInvariants(factories)).toThrow(
      /Bare tool name dup/,
    );
  });

  test("rejects sideEffects keys that do not match bareToolNames", () => {
    const factories = [
      factory({
        factoryId: "a",
        bareToolNames: ["one"],
        sideEffects: { one: "read", extra: "write" },
      }),
    ];
    expect(() => assertToolManifestFactoryInvariants(factories)).toThrow(
      /sideEffects/,
    );
  });
});
