// Regression for CL-6334: `SKILLS_TOOL_PACKAGE_PIN` named
// `@corbits/tools-skills`, but `tool-registry-publish`'s
// `CORBITS_TOOL_PACKAGE_DIRS` never listed that package's directory, so
// a definition pinning skills carried a pin the corbits-tools registry
// could never resolve at launch.
import { describe, expect, test } from "bun:test";
import { describeCorbitsToolPackages } from "@corbits/tool-registry-publish";
import { SKILLS_TOOL_PACKAGE_PIN } from "./agent-workflow";

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
