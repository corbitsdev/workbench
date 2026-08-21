// CL-6495: the create-workbench catch used to discard whatever
// `createWorkbenchFromTemplate` threw behind a fixed "try again" toast —
// honest for a transient failure, a lie for a precondition this bench
// doesn't meet (no setup agent, an unavailable template). These pin the
// wording `describeWorkbenchCreateFailure` picks for each shape of cause.

import { describe, expect, test } from "bun:test";
import { ApiQueryError } from "@corbits/api-query";

import { describeWorkbenchCreateFailure } from "./new-workbench-picker";

describe("describeWorkbenchCreateFailure", () => {
  test("a precondition Error (no setup agent, unavailable template) is shown verbatim, not flattened to a retry prompt", () => {
    expect(
      describeWorkbenchCreateFailure(
        new Error("A code-review workbench isn't available here yet."),
      ),
    ).toBe("A code-review workbench isn't available here yet.");
  });

  test("an ApiQueryError runs through describeApiError so the status drives the wording", () => {
    expect(describeWorkbenchCreateFailure(new ApiQueryError("boom", 404))).toBe(
      "This isn't here anymore.",
    );
    expect(describeWorkbenchCreateFailure(new ApiQueryError("boom", 401))).toBe(
      "You don't have access to this.",
    );
  });

  test("a network-level ApiQueryError with no status still names retrying as the honest answer", () => {
    expect(
      describeWorkbenchCreateFailure(new ApiQueryError("Failed to fetch")),
    ).toBe("Something went wrong creating this workbench. Try again.");
  });

  test("a non-Error cause falls back to the same generic, honest message", () => {
    expect(describeWorkbenchCreateFailure("boom")).toBe(
      "Something went wrong creating this workbench. Try again.",
    );
  });
});
