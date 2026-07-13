import { describe, expect, it } from "bun:test";
import {
  flatBareToolNames,
  loadCommittedToolManifestFactories,
} from "@workbench/tool-manifest";
import { KNOWN_TOOLS } from "./tool-registry";

/** Hub-backed tools with no `@workbench/tools-*` manifest row (tasks rail). */
const HUB_ONLY_TOOLS_NOT_IN_MANIFEST = [
  "task_create",
  "task_list",
  "task_update",
] as const;

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
});
