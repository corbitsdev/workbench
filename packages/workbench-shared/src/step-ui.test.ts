import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { StepUIEntrySchema, StepUISchema } from "./step-ui";

describe("StepUIEntrySchema", () => {
  test("accepts an entry with every field", () => {
    const entry = StepUIEntrySchema({
      role: "intake",
      title: "Sources",
      input: [{ kind: "text", name: "topic", required: true }],
      output: { block: "reviewList" },
    });
    expect(entry instanceof type.errors).toBe(false);
  });

  test("accepts an entry with no fields at all", () => {
    const entry = StepUIEntrySchema({});
    expect(entry instanceof type.errors).toBe(false);
  });

  test("rejects an unknown role", () => {
    const entry = StepUIEntrySchema({ role: "bogus" });
    expect(entry instanceof type.errors).toBe(true);
  });

  test("rejects an input field with an unknown kind", () => {
    const entry = StepUIEntrySchema({
      input: [{ kind: "checkbox", name: "topic" }],
    });
    expect(entry instanceof type.errors).toBe(true);
  });

  test("rejects an input field missing its required name", () => {
    const entry = StepUIEntrySchema({
      input: [{ kind: "text" }],
    });
    expect(entry instanceof type.errors).toBe(true);
  });
});

describe("StepUISchema", () => {
  test("accepts a step-id keyed map matching the STEP_UI shape from the brief", () => {
    const stepUI = StepUISchema({
      collectInputs: {
        role: "intake",
        title: "Sources",
        input: [{ kind: "text", name: "topic", required: true }],
      },
      review: { title: "Pain points", output: { block: "reviewList" } },
      persist: { title: "Save" },
    });
    expect(stepUI instanceof type.errors).toBe(false);
  });

  test("rejects a map whose entry fails validation", () => {
    const stepUI = StepUISchema({
      intake: { role: "not-a-role" },
    });
    expect(stepUI instanceof type.errors).toBe(true);
  });
});
