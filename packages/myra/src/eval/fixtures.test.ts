import { describe, expect, test } from "bun:test";
import { EvalCaseSchema } from "./case";
import { V1_EVAL_CASES, evalCaseById } from "./fixtures";
import { evalToolsByName, DEFAULT_EVAL_ADVERTISED_TOOL_NAMES } from "./tools";

describe("V1_EVAL_CASES", () => {
  test("every case validates against EvalCaseSchema", () => {
    for (const c of V1_EVAL_CASES) {
      const parsed = EvalCaseSchema(c);
      expect(parsed instanceof Error).toBe(false);
      if (!(parsed instanceof Error)) {
        expect(parsed.id).toBe(c.id);
      }
    }
  });

  test("case ids are unique", () => {
    const ids = V1_EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("covers the hard-case tags from CL-3193", () => {
    const tags = new Set(V1_EVAL_CASES.flatMap((c) => c.tags));
    for (const required of [
      "greeting",
      "internal-first",
      "fresh-data",
      "clarification",
      "failure",
      "missing-capability",
      "approval",
      "injection",
      "workflow",
      "multi-step",
    ]) {
      expect(tags.has(required)).toBe(true);
    }
  });

  test("advertised and fixture tool names exist in the synthetic registry", () => {
    for (const c of V1_EVAL_CASES) {
      const advertised = c.advertisedTools ?? DEFAULT_EVAL_ADVERTISED_TOOL_NAMES;
      expect(() => evalToolsByName(advertised)).not.toThrow();
      for (const fixture of c.toolFixtures ?? []) {
        expect(() => evalToolsByName([fixture.name])).not.toThrow();
      }
      for (const name of c.constraints.mustCallTools ?? []) {
        expect(() => evalToolsByName([name])).not.toThrow();
      }
    }
  });

  test("evalCaseById throws on unknown id", () => {
    expect(() => evalCaseById("nope")).toThrow(/unknown case id/);
  });

  test("fixtures contain no credential-like strings", () => {
    const blob = JSON.stringify(V1_EVAL_CASES);
    expect(blob).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(blob).not.toMatch(/api[_-]?key\s*[:=]\s*["'][^"']+["']/i);
  });
});
