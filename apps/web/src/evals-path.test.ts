import { describe, expect, test } from "bun:test";

import { parseEvalsPath } from "./evals-path";

describe("parseEvalsPath", () => {
  test("resolves the list path", () => {
    expect(parseEvalsPath("/evals")).toEqual({ mode: "list", runId: null });
    expect(parseEvalsPath("/evals/")).toEqual({ mode: "list", runId: null });
  });

  test("resolves a run deep link", () => {
    expect(parseEvalsPath("/evals/evalrun_1")).toEqual({
      mode: "run",
      runId: "evalrun_1",
    });
  });

  test("a malformed escape on a run deep link falls back to list, not a throw", () => {
    expect(() => parseEvalsPath("/evals/%")).not.toThrow();
    expect(parseEvalsPath("/evals/%")).toEqual({ mode: "list", runId: null });
  });

  test("an unrelated path falls back to list", () => {
    expect(parseEvalsPath("/insights")).toEqual({ mode: "list", runId: null });
  });
});
