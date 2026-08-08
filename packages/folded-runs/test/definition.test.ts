// Proves `readFoldedBody`'s validation of a parsed folded
// `WorkflowDefinition`: it extracts the launch-relevant subset of a
// single-step definition's step, and fails loud on a malformed
// definition, a multi-step one, or a step that isn't a step primitive
// — rather than casting an untyped blob into `@intx/workflow`'s real
// (function-bearing) `WorkflowDefinition` type.
import { describe, expect, test } from "bun:test";
import { readFoldedBody } from "../src/definition";

function foldedDefinition(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "wfd_1",
    stepOrder: ["host"],
    steps: {
      host: {
        kind: "step",
        agent: {
          systemPrompt: "you are a channel host",
          toolPackagePins: [],
          inference: { sources: [{ model: "claude-sonnet-5" }] },
        },
      },
    },
    grantRequirements: [],
    credentialBindings: [],
    ...overrides,
  };
}

describe("readFoldedBody", () => {
  test("extracts the launch-relevant subset of a valid single-step definition", () => {
    const body = readFoldedBody(foldedDefinition());
    expect(body).toEqual({
      systemPrompt: "you are a channel host",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: "claude-sonnet-5",
    });
  });

  test("fails loud on a malformed definition", () => {
    expect(() => readFoldedBody({ not: "a definition" })).toThrow(
      /folded definition is malformed/,
    );
  });

  test("fails loud on a multi-step definition", () => {
    const definition = foldedDefinition({ stepOrder: ["host", "second"] });
    expect(() => readFoldedBody(definition)).toThrow(/not single-step/);
  });

  test("fails loud when the named step is not a step primitive", () => {
    const definition = foldedDefinition({
      steps: { host: { kind: "not-a-step" } },
    });
    expect(() => readFoldedBody(definition)).toThrow(/is not a step primitive/);
  });
});
