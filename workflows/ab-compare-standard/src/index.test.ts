import { describe, expect, test } from "bun:test";
import { workflow, kind, label, ARTIFACT_KIND } from "./index";

describe("ab-compare-standard workflow package", () => {
  test("wires the Standard preset with four fixed variant lanes", () => {
    expect(kind).toBe("ab-compare-standard");
    expect(workflow.id).toBe("ab-compare-standard");
    expect(label).toContain("Standard");
    expect(ARTIFACT_KIND).toBe("ab-comparison");
    const execIds = Object.keys(workflow.steps).filter((s) =>
      /^exec\d+$/u.test(s),
    );
    expect(execIds).toHaveLength(4);
    expect(workflow.steps.quorum).toBeDefined();
  });
});
