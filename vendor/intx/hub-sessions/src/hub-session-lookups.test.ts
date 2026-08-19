import { describe, expect, test } from "bun:test";

import { ownsWorkflowRunRepo } from "./hub-session-lookups";

describe("ownsWorkflowRunRepo", () => {
  const anchor = {
    id: "run_1",
    address: "run_1@alice.localhost",
    anchorRunId: "run_1",
  };

  test("accepts a self-anchored row with a routable address", () => {
    expect(ownsWorkflowRunRepo(anchor)).toBe(true);
  });

  test("accepts a terminal anchor so its own teardown bookkeeping can land", () => {
    // The status column is not part of the gate: a terminal run must still be
    // able to enqueue and reject mail that arrived in its teardown window.
    expect(ownsWorkflowRunRepo({ ...anchor })).toBe(true);
  });

  test("rejects an address with no anchor row", () => {
    expect(ownsWorkflowRunRepo(undefined)).toBe(false);
  });

  test("rejects a child run that does not anchor its own deployment", () => {
    expect(ownsWorkflowRunRepo({ ...anchor, anchorRunId: "run_0" })).toBe(false);
  });

  test("rejects an anchor with no address", () => {
    expect(ownsWorkflowRunRepo({ ...anchor, address: null })).toBe(false);
  });
});
