import { describe, expect, test } from "bun:test";
import { workflowRunStateStatus } from "../db/schema";
import {
  NON_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  becameTerminal,
  isTerminalRunStatus,
  type RunStatus,
} from "./run-status";

describe("run-status terminal partition (CL-2575 invariant)", () => {
  test("terminal + non-terminal sets exactly partition the schema enum", () => {
    const partition = [
      ...TERMINAL_RUN_STATUSES,
      ...NON_TERMINAL_RUN_STATUSES,
    ].sort();
    // If a new status is added to the schema and not classified here, this
    // fails — forcing an explicit terminal/non-terminal decision rather than a
    // silent default (which is how `awaiting` got mis-treated as terminal).
    expect(partition).toEqual([...workflowRunStateStatus].sort());
    // No status is in both sets.
    for (const s of TERMINAL_RUN_STATUSES) {
      expect(NON_TERMINAL_RUN_STATUSES).not.toContain(s);
    }
  });

  test("awaiting is NOT terminal; completed/failed/stopped are", () => {
    expect(isTerminalRunStatus("awaiting")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("stopped")).toBe(true);
  });

  test("becameTerminal fires only on a non-terminal → terminal transition", () => {
    // The reclaim triggers — a run finishing.
    expect(becameTerminal("running", "completed")).toBe(true);
    expect(becameTerminal("running", "failed")).toBe(true);
    expect(becameTerminal("awaiting", "completed")).toBe(true);
    expect(becameTerminal("awaiting", "failed")).toBe(true);
    expect(becameTerminal("running", "stopped")).toBe(true);

    // The CL-2575 traps — parking at a gate must NEVER trip teardown.
    expect(becameTerminal("running", "awaiting")).toBe(false);
    expect(becameTerminal("awaiting", "awaiting")).toBe(false);
    expect(becameTerminal("running", "running")).toBe(false);

    // Idempotency — a second projection after terminal must not re-fire.
    expect(becameTerminal("completed", "completed")).toBe(false);
    expect(becameTerminal("failed", "failed")).toBe(false);
  });

  test("every non-terminal → terminal pair drawn from the schema enum is detected", () => {
    const statuses = workflowRunStateStatus as readonly RunStatus[];
    for (const prev of statuses) {
      for (const next of statuses) {
        const expected =
          !isTerminalRunStatus(prev) && isTerminalRunStatus(next);
        expect(becameTerminal(prev, next)).toBe(expected);
      }
    }
  });
});
