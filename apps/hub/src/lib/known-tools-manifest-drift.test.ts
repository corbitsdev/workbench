import { describe, expect, it } from "bun:test";
import { HUB_ONLY_TOOL_SIDE_EFFECTS } from "@workbench/agents";
import {
  flatBareToolNames,
  loadCommittedToolManifestFactories,
} from "@workbench/tool-manifest";
import { KNOWN_TOOLS } from "./tool-registry";

const HUB_ONLY_TOOLS_NOT_IN_MANIFEST = Object.keys(
  HUB_ONLY_TOOL_SIDE_EFFECTS,
).sort();

describe("KNOWN_TOOLS drift guard (CL-3447)", () => {
  it("includes every bare tool name from committed tool manifests", () => {
    const manifestNames = flatBareToolNames(
      loadCommittedToolManifestFactories(),
    );
    const missing = manifestNames.filter((name) => KNOWN_TOOLS[name] == null);
    expect(missing).toEqual([]);
  });

  it("does not register tools absent from committed manifests", () => {
    const manifestSet = new Set(
      flatBareToolNames(loadCommittedToolManifestFactories()),
    );
    const hubOnly = new Set<string>(HUB_ONLY_TOOLS_NOT_IN_MANIFEST);
    const extra = Object.keys(KNOWN_TOOLS).filter(
      (name) => !manifestSet.has(name) && !hubOnly.has(name),
    );
    expect(extra).toEqual([]);
  });

  it("matches KNOWN_TOOLS sideEffect to committed manifest sideEffects", () => {
    const mismatches: string[] = [];
    for (const factory of loadCommittedToolManifestFactories()) {
      for (const name of factory.bareToolNames) {
        const manifestEffect = factory.sideEffects[name];
        const known = KNOWN_TOOLS[name];
        if (known == null) continue;
        if (known.sideEffect !== manifestEffect) {
          mismatches.push(
            `${name}: KNOWN_TOOLS=${known.sideEffect} manifest=${manifestEffect}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches KNOWN_TOOLS sideEffect for hub-only tools not in manifests", () => {
    const mismatches: string[] = [];
    for (const [name, effect] of Object.entries(HUB_ONLY_TOOL_SIDE_EFFECTS)) {
      const known = KNOWN_TOOLS[name];
      if (known == null) {
        mismatches.push(`${name}: missing from KNOWN_TOOLS`);
        continue;
      }
      if (known.sideEffect !== effect) {
        mismatches.push(
          `${name}: KNOWN_TOOLS=${known.sideEffect} hub-only=${effect}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
