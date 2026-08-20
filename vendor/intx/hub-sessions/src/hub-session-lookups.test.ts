import { describe, expect, test } from "bun:test";

import {
  anchorAddressForPackSource,
  ownsWorkflowRunRepo,
} from "./hub-session-lookups";

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

describe("anchorAddressForPackSource", () => {
  const runId = "run_5554796211fb7e08f1748bd9db41f71f";
  const domain = "workbench.localhost";

  test("resolves a base deployment address to itself", () => {
    expect(anchorAddressForPackSource(`${runId}@${domain}`)).toBe(
      `${runId}@${domain}`,
    );
  });

  test("peels a per-step address back to its base run's anchor address", () => {
    // Mirrors deriveStepAddress in
    // vendor/intx/workflow-deploy/src/orchestrator.ts:837.
    expect(anchorAddressForPackSource(`${runId}-write@${domain}`)).toBe(
      `${runId}@${domain}`,
    );
  });

  test("peels a step id that itself contains dashes", () => {
    expect(
      anchorAddressForPackSource(`${runId}-fetch-and-write@${domain}`),
    ).toBe(`${runId}@${domain}`);
  });

  test("returns null for an address with no run_ prefix", () => {
    expect(anchorAddressForPackSource(`not-a-run@${domain}`)).toBe(null);
  });

  test("returns null for a malformed address parseRunAddress rejects", () => {
    expect(anchorAddressForPackSource("no-at-sign")).toBe(null);
  });

  test("returns null for a run id shorter than the minted hex length", () => {
    expect(anchorAddressForPackSource(`run_deadbeef@${domain}`)).toBe(null);
  });
});
