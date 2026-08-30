import { describe, expect, test } from "bun:test";

import { canStopComposer, insertTextAtCaret } from "./composer";

describe("insertTextAtCaret", () => {
  test("splices the insertion in at the caret", () => {
    const result = insertTextAtCaret("hello world", 6, "@myra ");
    expect(result.text).toBe("hello @myra world");
    expect(result.caret).toBe(12);
  });

  test("appends at the end when the caret sits past the text", () => {
    const result = insertTextAtCaret("hi", 2, "@myra ");
    expect(result.text).toBe("hi@myra ");
    expect(result.caret).toBe(8);
  });

  test("inserts into an empty draft", () => {
    const result = insertTextAtCaret("", 0, "@myra ");
    expect(result.text).toBe("@myra ");
    expect(result.caret).toBe(6);
  });
});

// CL-7201: the composer's stop affordance is a stand-in for "is there a
// turn to cancel" — offered whenever the host says a turn is running,
// independent of the composer's own `sending`/`preparing` state (queuing
// a follow-up message while a turn runs is still allowed, so the stop
// affordance and the send button coexist rather than one gating the
// other).
describe("canStopComposer", () => {
  test("offers Stop while the host reports a turn running", () => {
    expect(canStopComposer({ running: true })).toBe(true);
  });

  test("offers nothing when no turn is running", () => {
    expect(canStopComposer({ running: false })).toBe(false);
  });
});
