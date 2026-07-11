import { describe, expect, it } from "bun:test";
import { createToolLoopGuard } from "./tool-loop-guard";

const S = "ses_1";

describe("createToolLoopGuard", () => {
  it("stays silent on the first failure of a call", () => {
    const guard = createToolLoopGuard();
    expect(guard.recordFailure(S, "artifact_create", { kind: "note" })).toBe(
      undefined,
    );
  });

  it("does not count a client abort toward escalation", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "t", { a: 1 });
    const abortError = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    expect(guard.recordFailure(S, "t", { a: 1 }, abortError)).toBe(undefined);
    expect(guard.recordFailure(S, "t", { a: 1 }, abortError)).toBe(undefined);
    // The run is untouched: the next real failure is only the 2nd.
    expect(guard.recordFailure(S, "t", { a: 1 })).toContain("2 times in a row");
  });

  it("escalates with a hint on the second consecutive identical failure", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    const hint = guard.recordFailure(S, "artifact_create", { kind: "note" });
    expect(hint).toContain("2 times in a row");
    expect(hint).toContain("Change the arguments");
  });

  it("hard-stops on the third consecutive identical failure", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    const stop = guard.recordFailure(S, "artifact_create", { kind: "note" });
    expect(stop).toContain("blocked");
  });

  it("blocks the call pre-execution once the ceiling is reached", () => {
    const guard = createToolLoopGuard();
    expect(guard.checkBlocked(S, "artifact_create", { kind: "note" })).toBe(
      undefined,
    );
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    expect(guard.checkBlocked(S, "artifact_create", { kind: "note" })).toBe(
      undefined,
    );
    guard.recordFailure(S, "artifact_create", { kind: "note" });
    const blocked = guard.checkBlocked(S, "artifact_create", { kind: "note" });
    expect(blocked).toContain("blocked");
  });

  it("treats args as identical regardless of key order", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "t", { a: 1, b: { c: 2, d: 3 } });
    const hint = guard.recordFailure(S, "t", { b: { d: 3, c: 2 }, a: 1 });
    expect(hint).toContain("2 times in a row");
  });

  it("resets on a different call (name or args)", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "t", { a: 1 });
    guard.recordFailure(S, "t", { a: 2 });
    expect(guard.recordFailure(S, "t", { a: 2 })).toContain("2 times in a row");
    expect(guard.recordFailure(S, "other", { a: 2 })).toBe(undefined);
    expect(guard.recordFailure(S, "other", { a: 2 })).toContain(
      "2 times in a row",
    );
  });

  it("resets on a success", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure(S, "t", { a: 1 });
    guard.recordFailure(S, "t", { a: 1 });
    guard.recordSuccess(S);
    expect(guard.recordFailure(S, "t", { a: 1 })).toBe(undefined);
    expect(guard.checkBlocked(S, "t", { a: 1 })).toBe(undefined);
  });

  it("tracks sessions independently", () => {
    const guard = createToolLoopGuard();
    guard.recordFailure("ses_a", "t", { a: 1 });
    expect(guard.recordFailure("ses_b", "t", { a: 1 })).toBe(undefined);
  });

  it("evicts the least-recently-used session at the cap", () => {
    const guard = createToolLoopGuard({ maxSessions: 1 });
    guard.recordFailure("ses_a", "t", { a: 1 });
    guard.recordFailure("ses_b", "t", { a: 1 });
    // ses_a was evicted, so its next failure starts a fresh run.
    expect(guard.recordFailure("ses_a", "t", { a: 1 })).toBe(undefined);
  });
});
