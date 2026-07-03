import { describe, expect, it } from "bun:test";
import { type } from "arktype";

import {
  WorkflowRunFactInputSchema,
  WorkflowStepFactInputSchema,
} from "./workflow-facts";

// The fact schemas are the query/write boundary contract. These assert the
// runtime validator actually rejects an out-of-vocabulary outcome/kind and
// accepts a well-formed fact — so a silent widening of the contract fails here.

describe("WorkflowRunFactInputSchema", () => {
  it("accepts a well-formed run fact", () => {
    const out = WorkflowRunFactInputSchema({
      runId: "r1",
      tenantId: "tn",
      kind: "brief",
      outcome: "completed",
      durationMs: 1000,
    });
    expect(out instanceof type.errors).toBe(false);
  });

  it("rejects an outcome outside the vocabulary", () => {
    const out = WorkflowRunFactInputSchema({
      runId: "r1",
      tenantId: "tn",
      kind: "brief",
      outcome: "in-progress",
    });
    expect(out instanceof type.errors).toBe(true);
  });
});

describe("WorkflowStepFactInputSchema", () => {
  it("rejects an unknown step kind", () => {
    const out = WorkflowStepFactInputSchema({
      runId: "r1",
      stepId: "s1",
      attempt: 1,
      tenantId: "tn",
      kind: "brief",
      stepKind: "wizard",
      outcome: "completed",
    });
    expect(out instanceof type.errors).toBe(true);
  });

  it("accepts a well-formed step fact with a gate wait", () => {
    const out = WorkflowStepFactInputSchema({
      runId: "r1",
      stepId: "s1",
      attempt: 1,
      tenantId: "tn",
      kind: "brief",
      stepKind: "human",
      outcome: "completed",
      gateWaitMs: 2000,
    });
    expect(out instanceof type.errors).toBe(false);
  });
});
