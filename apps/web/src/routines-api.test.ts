import { describe, expect, test } from "bun:test";

import { routineCreatedToast, routineRunStartedToast } from "./routines-api";

describe("routine toast copy", () => {
  test("create carries the routine's name", () => {
    expect(routineCreatedToast("Morning brief")).toBe(
      "Routine created · Morning brief",
    );
  });

  test("run-now confirms the run has started", () => {
    expect(routineRunStartedToast("Morning brief")).toBe(
      "Run started · Morning brief",
    );
  });
});
