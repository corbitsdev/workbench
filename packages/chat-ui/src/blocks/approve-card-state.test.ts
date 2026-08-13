import { describe, expect, test } from "bun:test";

import { deriveApproveCardView, isTerminalStatus } from "./approve-card-state";

describe("isTerminalStatus", () => {
  test("pending is not terminal", () => {
    expect(isTerminalStatus("pending")).toBe(false);
  });

  test("approved, rejected, timeout, and expired are terminal", () => {
    expect(isTerminalStatus("approved")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("timeout")).toBe(true);
    expect(isTerminalStatus("expired")).toBe(true);
  });
});

describe("deriveApproveCardView", () => {
  test("no host port at all renders the pre-round-trip fixed-disabled framing", () => {
    const view = deriveApproveCardView({
      wired: false,
      live: { kind: "loading" },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({ kind: "unwired" });
  });

  test("the status read still loading renders loading", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "loading" },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({ kind: "loading" });
  });

  test("pending + canAct renders actionable with live buttons", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "ready", status: "pending", canAct: true },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({ kind: "actionable", deciding: null, error: null });
  });

  test("pending + !canAct renders spectator: status shown, no buttons", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "ready", status: "pending", canAct: false },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({ kind: "spectator", status: "pending" });
  });

  test("a terminal status always renders resolved, even if canAct were true", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "ready", status: "approved", canAct: true },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({ kind: "resolved", status: "approved" });
  });

  test("a forbidden read cannot determine actionability: buttons render, error carries through", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "forbidden" },
      deciding: "approve",
      decisionError: "You do not have permission to act on this.",
    });
    expect(view).toEqual({
      kind: "undetermined",
      deciding: "approve",
      error: "You do not have permission to act on this.",
    });
  });

  test("not-found and error reads never fabricate a status", () => {
    expect(
      deriveApproveCardView({
        wired: true,
        live: { kind: "not-found" },
        deciding: null,
        decisionError: null,
      }),
    ).toEqual({ kind: "not-found" });

    expect(
      deriveApproveCardView({
        wired: true,
        live: { kind: "error", message: "network down" },
        deciding: null,
        decisionError: null,
      }),
    ).toEqual({ kind: "load-error", message: "network down" });
  });
});
