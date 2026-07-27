import { describe, expect, test } from "bun:test";
import {
  assertGateStepsHaveStepUIEntry,
  assertStepUIKeysMatchStepIds,
} from "@workbench/shared";
import { workflow } from "./index";
import {
  CompetitorAnalysisIntakePayloadSchema,
  INTAKE_FIELDS,
  INTAKE_SIGNAL,
  REVIEW_SIGNAL,
  STEP_UI,
} from "./step-ui";

function gateStepIds(): string[] {
  return Object.entries(workflow.steps)
    .filter(([, primitive]) => primitive.kind === "awaitSignal")
    .map(([id]) => id);
}

describe("competitor-analysis STEP_UI", () => {
  test("every STEP_UI key matches a real step id", () => {
    expect(() =>
      assertStepUIKeysMatchStepIds(STEP_UI, Object.keys(workflow.steps)),
    ).not.toThrow();
  });

  test("every awaitSignal gate has a STEP_UI entry", () => {
    expect(() =>
      assertGateStepsHaveStepUIEntry(STEP_UI, gateStepIds()),
    ).not.toThrow();
  });

  test("intake: form entry with required url and optional name/focus", () => {
    const intake = STEP_UI[INTAKE_SIGNAL];
    expect(intake?.role).toBe("intake");
    expect(intake?.input?.map((f) => f.name)).toEqual([
      "url",
      "companyName",
      "focusNotes",
    ]);
    const url = intake?.input?.[0];
    expect(url?.kind).toBe("text");
    expect(url?.required).toBe(true);
  });

  test("review: a dynamic gate sourced from reviewGate's output", () => {
    const review = STEP_UI[REVIEW_SIGNAL];
    expect(review?.role).toBe("review");
    expect(review?.gateFromOutput).toBe(true);
    expect(review?.gateSourceStep).toBe("reviewGate");
  });

  test("INTAKE_FIELDS covers every key CompetitorAnalysisIntakePayloadSchema requires", () => {
    const requiredKeys = ["url"];
    const declaredNames = INTAKE_FIELDS.map((f) => f.name);
    for (const key of requiredKeys) {
      expect(declaredNames).toContain(key);
    }
    const parsed = CompetitorAnalysisIntakePayloadSchema({
      url: "https://acme.com",
    });
    expect(parsed).not.toBeInstanceOf(Error);
  });
});
