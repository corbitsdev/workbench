import { describe, expect, it, test } from "bun:test";
import type { ToolDefinition } from "@intx/types/runtime";
import * as agentsIndex from "./index";
import {
  parseListLimit,
  parsePrincipalIds,
  resolveStatusFilter,
} from "./index";
import { toolManifestFile } from "./tool-manifest";

function isToolDefinitionLike(value: unknown): value is ToolDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).description === "string" &&
    typeof (value as Record<string, unknown>).inputSchema === "object"
  );
}

describe("resolveStatusFilter", () => {
  it("defaults to running when no status is given", () => {
    expect(resolveStatusFilter(undefined)).toBe("running");
  });

  it("returns the granular status when a valid one is given", () => {
    expect(resolveStatusFilter("stopped")).toBe("stopped");
    expect(resolveStatusFilter("error")).toBe("error");
  });

  it("returns undefined (no filter) for the all escape hatch", () => {
    expect(resolveStatusFilter("all")).toBeUndefined();
  });

  it("throws including all in the allowed list for an unknown status", () => {
    expect(() => resolveStatusFilter("banana")).toThrow(
      /status must be one of:.*all/,
    );
  });

  it("throws when status is not a string", () => {
    expect(() => resolveStatusFilter(5)).toThrow(/status must be a string/);
  });
});

describe("parsePrincipalIds", () => {
  it("returns undefined when no principals are given", () => {
    expect(parsePrincipalIds(undefined)).toBeUndefined();
  });

  it("returns the provided principal ids when given a non-empty array", () => {
    expect(parsePrincipalIds(["prn_a", "prn_b"])).toEqual(["prn_a", "prn_b"]);
  });

  it("throws when principals is not an array", () => {
    expect(() => parsePrincipalIds("prn_a")).toThrow(
      /principals must be an array/,
    );
  });

  it("throws when principals is an empty array", () => {
    expect(() => parsePrincipalIds([])).toThrow(/non-empty/);
  });

  it("throws when principals contains a non-string element", () => {
    expect(() => parsePrincipalIds(["prn_a", 5])).toThrow(
      /principals must contain only strings/,
    );
  });
});

describe("parseListLimit", () => {
  it("defaults to 50 when not a finite number", () => {
    expect(parseListLimit(undefined)).toBe(50);
    expect(parseListLimit("x")).toBe(50);
  });

  it("clamps to the 1-200 range", () => {
    expect(parseListLimit(9999)).toBe(200);
    expect(parseListLimit(0)).toBe(1);
    expect(parseListLimit(10)).toBe(10);
  });
});

describe("tool-manifest completeness", () => {
  test("every exported tool definition is declared in the hand-authored manifest", () => {
    // No single runtime array enumerates this package's tools the way
    // ARTIFACT_TOOL_DEFINITIONS/SKILL_TOOL_DEFINITIONS do elsewhere — list_agents
    // and identity_get/identity_set/invoke_agent dispatch through the sidecar
    // factory in interchange-tools.ts, while search_agents dispatches as a
    // hub-native ContextToolEntry (apps/hub/src/tools/search-agents.ts). Both
    // paths re-export their `*_DEFINITION` through this module, so discovering
    // every ToolDefinition-shaped export here (rather than hand-listing the
    // paths) still gives a guard that automatically grows if a new tool
    // definition is exported and re-exported through index.ts.
    const runtimeNames = Object.values(agentsIndex)
      .filter(isToolDefinitionLike)
      .map((definition) => definition.name)
      .sort();
    const factory = toolManifestFile.factories[0];
    if (!factory) {
      throw new Error("expected the agents manifest to declare a factory");
    }
    const manifestNames = [...factory.bareToolNames].sort();
    expect(manifestNames).toEqual(runtimeNames);
  });
});
