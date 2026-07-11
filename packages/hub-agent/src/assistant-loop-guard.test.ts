import { describe, test, expect } from "bun:test";

import {
  ASSISTANT_LOOP_THRESHOLD,
  createAssistantLoopGuard,
  extractAssistantText,
  normalizeAssistantOutput,
} from "./assistant-loop-guard";

describe("createAssistantLoopGuard", () => {
  test("stays silent on the first two identical outputs and trips on the third", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "hello there")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "hello there")).toBeUndefined();
    const interrupt = guard.recordAssistantOutput("s1", "hello there");
    expect(interrupt).toBeDefined();
    expect(interrupt).toContain(String(ASSISTANT_LOOP_THRESHOLD));
  });

  test("near-identical outputs never trip", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "attempt one")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "attempt two")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "attempt three")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "attempt one!")).toBeUndefined();
  });

  test("whitespace-only differences count as identical", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "hello   world")).toBeUndefined();
    expect(
      guard.recordAssistantOutput("s1", "  hello world  "),
    ).toBeUndefined();
    expect(
      guard.recordAssistantOutput("s1", "hello\n\tworld"),
    ).not.toBeUndefined();
  });

  test("a different output resets the run", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "different")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).not.toBeUndefined();
  });

  test("reset clears the run (user message)", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    guard.reset("s1");
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).not.toBeUndefined();
  });

  test("empty and whitespace-only outputs are ignored", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "   \n ")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).not.toBeUndefined();
  });

  test("tripping clears the run so the session stays usable", () => {
    const guard = createAssistantLoopGuard();
    guard.recordAssistantOutput("s1", "same");
    guard.recordAssistantOutput("s1", "same");
    expect(guard.recordAssistantOutput("s1", "same")).not.toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
  });

  test("sessions are tracked independently", () => {
    const guard = createAssistantLoopGuard();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s2", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s2", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s2", "same")).not.toBeUndefined();
  });

  test("evicts the least-recently-used session at the cap", () => {
    const guard = createAssistantLoopGuard({ maxSessions: 1 });
    guard.recordAssistantOutput("s1", "same");
    guard.recordAssistantOutput("s1", "same");
    guard.recordAssistantOutput("s2", "other");
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
  });

  test("custom threshold is honored", () => {
    const guard = createAssistantLoopGuard({ threshold: 2 });
    expect(guard.recordAssistantOutput("s1", "same")).toBeUndefined();
    expect(guard.recordAssistantOutput("s1", "same")).not.toBeUndefined();
  });
});

describe("normalizeAssistantOutput", () => {
  test("trims and collapses internal whitespace", () => {
    expect(normalizeAssistantOutput("  a \n\t b  ")).toBe("a b");
  });
});

describe("extractAssistantText", () => {
  test("joins text blocks and ignores non-text blocks", () => {
    const text = extractAssistantText([
      { type: "text", text: "one" },
      { type: "thinking" },
      { type: "text", text: "two" },
    ]);
    expect(text).toBe("one\ntwo");
  });
});
