import { describe, expect, test } from "bun:test";
import { workflow, kind, label, ARTIFACT_KIND } from "./index";

describe("ab-compare-quality workflow package", () => {
  test("wires the Quality preset with four fixed variant lanes", () => {
    expect(kind).toBe("ab-compare-quality");
    expect(workflow.id).toBe("ab-compare-quality");
    expect(label).toContain("Quality");
    expect(ARTIFACT_KIND).toBe("ab-comparison");
    const execIds = Object.keys(workflow.steps).filter((s) =>
      /^exec\d+$/u.test(s),
    );
    expect(execIds).toHaveLength(4);
    expect(workflow.steps.quorum).toBeDefined();
  });
});
