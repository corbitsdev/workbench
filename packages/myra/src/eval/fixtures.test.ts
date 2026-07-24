import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { EvalCaseSchema } from "./case";
import {
  ALL_EVAL_CASES,
  JUDGMENT_EVAL_CASES,
  V1_EVAL_CASES,
  evalCaseById,
} from "./fixtures";
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
      const advertised =
        c.advertisedTools ?? DEFAULT_EVAL_ADVERTISED_TOOL_NAMES;
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

describe("JUDGMENT_EVAL_CASES", () => {
  test("every case validates against EvalCaseSchema", () => {
    for (const c of JUDGMENT_EVAL_CASES) {
      const parsed = EvalCaseSchema(c);
      expect(parsed instanceof type.errors).toBe(false);
      if (!(parsed instanceof type.errors)) {
        expect(parsed.id).toBe(c.id);
      }
    }
  });

  test("has at least 7 cases", () => {
    // Started at 9; two ("live-instruction-overrides-saved-preference",
    // "outcome-first-reporting-shape") were removed on review (CL-4138) —
    // the deterministic scorer cannot inspect tool-call arguments or
    // answer ordering/structure, so neither could actually fail on the
    // behavior it named. See the README "Known scorer gap" note.
    expect(JUDGMENT_EVAL_CASES.length).toBeGreaterThanOrEqual(7);
  });

  test("case ids are unique across the judgment corpus and do not collide with v1", () => {
    const ids = JUDGMENT_EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const v1Ids = new Set(V1_EVAL_CASES.map((c) => c.id));
    for (const id of ids) {
      expect(v1Ids.has(id)).toBe(false);
    }
  });

  test("covers the CL-4138 judgment themes", () => {
    const tags = new Set(JUDGMENT_EVAL_CASES.flatMap((c) => c.tags));
    for (const required of [
      "ask-vs-act",
      "irreversible",
      "external-message",
      "delete",
      "teammate-note",
      "partial-failure",
      "search-loop-stop",
    ]) {
      expect(tags.has(required)).toBe(true);
    }
  });

  test("advertised and fixture tool names exist in the synthetic registry", () => {
    for (const c of JUDGMENT_EVAL_CASES) {
      const advertised =
        c.advertisedTools ?? DEFAULT_EVAL_ADVERTISED_TOOL_NAMES;
      expect(() => evalToolsByName(advertised)).not.toThrow();
      for (const fixture of c.toolFixtures ?? []) {
        expect(() => evalToolsByName([fixture.name])).not.toThrow();
      }
      for (const name of c.constraints.mustCallTools ?? []) {
        expect(() => evalToolsByName([name])).not.toThrow();
      }
      for (const name of c.constraints.toolSequence ?? []) {
        expect(() => evalToolsByName([name])).not.toThrow();
      }
    }
  });

  test("fixtures contain no credential-like strings", () => {
    const blob = JSON.stringify(JUDGMENT_EVAL_CASES);
    expect(blob).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(blob).not.toMatch(/api[_-]?key\s*[:=]\s*["'][^"']+["']/i);
  });
});

describe("ALL_EVAL_CASES", () => {
  test("is the concatenation of v1 and judgment corpora with no id collisions", () => {
    expect(ALL_EVAL_CASES.length).toBe(
      V1_EVAL_CASES.length + JUDGMENT_EVAL_CASES.length,
    );
    const ids = ALL_EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("evalCaseById resolves judgment cases too", () => {
    for (const c of JUDGMENT_EVAL_CASES) {
      expect(evalCaseById(c.id)).toBe(c);
    }
  });
});
