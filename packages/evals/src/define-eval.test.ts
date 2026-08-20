import { expect, test } from "bun:test";

import { defineEval } from "./define-eval.ts";

test("defineEval rejects a persona step with maxTurns below 1", () => {
  expect(() =>
    defineEval({
      name: "zero-turns",
      description: "test",
      steps: [
        {
          kind: "persona",
          opening: "set up my digest",
          persona: { name: "Dana", goal: "get a digest", knownFacts: {} },
          maxTurns: 0,
          expect: [],
        },
      ],
    }),
  ).toThrow('defineEval("zero-turns") step 0: maxTurns must be at least 1');
});

test("defineEval accepts a persona step with maxTurns of 1", () => {
  expect(() =>
    defineEval({
      name: "one-turn",
      description: "test",
      steps: [
        {
          kind: "persona",
          opening: "set up my digest",
          persona: { name: "Dana", goal: "get a digest", knownFacts: {} },
          maxTurns: 1,
          expect: [],
        },
      ],
    }),
  ).not.toThrow();
});
