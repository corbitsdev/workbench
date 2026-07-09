import { describe, expect, test } from "bun:test";
import { workflow, kind, label, ARTIFACT_KIND } from "./index";

describe("ab-compare-speed workflow package", () => {
  test("wires the Speed preset with four fixed variant lanes", () => {
    expect(kind).toBe("ab-compare-speed");
    expect(workflow.id).toBe("ab-compare-speed");
    expect(label).toContain("Speed");
    expect(ARTIFACT_KIND).toBe("ab-comparison");
    const execIds = Object.keys(workflow.steps).filter((s) =>
      /^exec\d+$/u.test(s),
    );
    expect(execIds).toHaveLength(4);
    expect(workflow.steps.quorum).toBeDefined();
  });
});
