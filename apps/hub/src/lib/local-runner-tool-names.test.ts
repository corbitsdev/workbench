/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { LOCAL_RUNNER_TOOL_NAMES } from "@workbench/agent-core";
import { TOOL_DEFINITIONS } from "@intx/tools-mail";

// packages/agent-core/src/tool-names.ts hand-maintains LOCAL_RUNNER_TOOL_NAMES
// as a mirror of @intx/tools-mail's TOOL_DEFINITIONS (agent-core stays
// framework-thin and does not depend on interchange). A code-review defect
// on the fail-closed workflow-step tool check found this mirror missing
// three of the five real mail tool names (mail_search, mail_read, mail_wait)
// — this guard fails the build the next time the two drift instead of
// silently reintroducing that bug.
describe("LOCAL_RUNNER_TOOL_NAMES mirrors @intx/tools-mail exactly", () => {
  it("contains exactly the tool names @intx/tools-mail registers", () => {
    const upstream = TOOL_DEFINITIONS.map((d) => d.name).sort();
    const mirrored = [...LOCAL_RUNNER_TOOL_NAMES].sort();
    expect(mirrored).toEqual(upstream);
  });
});
