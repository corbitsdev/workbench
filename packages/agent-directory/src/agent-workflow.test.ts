// Regression for CL-6334: `SKILLS_TOOL_PACKAGE_PIN` named
// `@corbits/tools-skills`, but `tool-registry-publish`'s
// `CORBITS_TOOL_PACKAGE_DIRS` never listed that package's directory, so
// a definition pinning skills carried a pin the corbits-tools registry
// could never resolve at launch.
import { describe, expect, test } from "bun:test";
import { describeCorbitsToolPackages } from "@corbits/tool-registry-publish";
import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
  SKILLS_TOOL_PACKAGE_PIN,
  withAgentToolPackagePin,
} from "./agent-workflow";

describe("SKILLS_TOOL_PACKAGE_PIN", () => {
  test("resolves through the corbits-tools registry", async () => {
    const descriptions = await describeCorbitsToolPackages();
    const match = descriptions.find(
      (description) => description.name === SKILLS_TOOL_PACKAGE_PIN.name,
    );
    expect(match).toBeDefined();
    expect(match?.version).toBe(SKILLS_TOOL_PACKAGE_PIN.version);
  });
});

// CL-7389: a runtime tool-package pin must resolve to a concrete,
// published version — never the npm "any version" range `*` — so a
// later tarball landing in the registry never silently changes what an
// already-deployed specialist runs.
describe("withAgentToolPackagePin", () => {
  function freshWorkflowJson(): string {
    return serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "pin-test",
        tenantDomain: "example.test",
        description: "",
        systemPrompt: "You are a test agent.",
      }),
    );
  }

  test("rejects a wildcard version", () => {
    expect(() =>
      withAgentToolPackagePin(freshWorkflowJson(), {
        name: "@corbits/memory-tools",
        version: "*",
      }),
    ).toThrow(/never "\*"/);
  });

  test("accepts a concrete version", () => {
    const nextWorkflowJson = withAgentToolPackagePin(freshWorkflowJson(), {
      name: "@corbits/memory-tools",
      version: "1.2.3",
    });
    const definition = JSON.parse(nextWorkflowJson) as {
      steps: Record<
        string,
        { agent: { toolPackagePins?: { name: string; version: string }[] } }
      >;
    };
    const [step] = Object.values(definition.steps);
    expect(step?.agent.toolPackagePins).toContainEqual({
      name: "@corbits/memory-tools",
      version: "1.2.3",
    });
  });
});
