import { describe, expect, test } from "bun:test";
import { canonicalizeToolNames } from "./tool-names";
import { PERSONAL_AGENT_BASE_TOOLS } from "./personal-agent/definition";
import { AGENT_TEMPLATES } from "./templates";

const FACTORY_ID = "@workbench/tools-workflows/workflows";
const TOOLS = ["workflow_start", "workflow_list_runs", "workflow_signal"];

// CL-2656: a tool must be in BOTH the PACKAGE_TOOLS prefixing table (so
// canonicalizeToolNames emits the runtime name authz checks) AND the grants
// list, or the runtime denies it at invoke time.
describe("workflow tools grant wiring (CL-2678)", () => {
  test("canonicalizeToolNames prefixes the workflow tools with their factory id", () => {
    expect(canonicalizeToolNames(TOOLS)).toEqual(
      TOOLS.map((name) => `${FACTORY_ID}:${name}`),
    );
  });

  test("PERSONAL_AGENT_BASE_TOOLS grants all three workflow tools by canonical name", () => {
    for (const name of TOOLS) {
      expect(PERSONAL_AGENT_BASE_TOOLS).toContain(`${FACTORY_ID}:${name}`);
    }
  });

  test("Myra's template pins @workbench/tools-workflows", () => {
    const myra = AGENT_TEMPLATES.find((t) => t.key === "myra");
    if (!myra) throw new Error("myra template missing");
    expect(
      (myra.toolPackages ?? []).map((p) => p.name),
    ).toContain("@workbench/tools-workflows");
  });
});
