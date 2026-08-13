import { describe, expect, test } from "bun:test";

import { deriveApproveCardView, isTerminalStatus } from "./approve-card-state";
import type { PlatformApprovalDetail } from "./approval-actions";

const DETAIL: PlatformApprovalDetail = {
  agentName: "Outreach Composer",
  headline: "send_email",
  arguments: { to: "customer@example.com" },
};

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

  test("pending + canAct renders actionable with live buttons and the platform's own detail", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: { kind: "ready", status: "pending", canAct: true, detail: DETAIL },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({
      kind: "actionable",
      detail: DETAIL,
      deciding: null,
      error: null,
    });
  });

  test("pending + !canAct renders spectator: status and platform detail shown, no buttons", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: {
        kind: "ready",
        status: "pending",
        canAct: false,
        detail: DETAIL,
      },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({
      kind: "spectator",
      status: "pending",
      detail: DETAIL,
    });
  });

  test("a terminal status always renders resolved, even if canAct were true", () => {
    const view = deriveApproveCardView({
      wired: true,
      live: {
        kind: "ready",
        status: "approved",
        canAct: true,
        detail: DETAIL,
      },
      deciding: null,
      decisionError: null,
    });
    expect(view).toEqual({
      kind: "resolved",
      status: "approved",
      detail: DETAIL,
      resolvedElsewhere: false,
    });
  });

  test("resolvedElsewhere only marks a genuinely resolved render", () => {
    const stillPending = deriveApproveCardView({
      wired: true,
      live: { kind: "ready", status: "pending", canAct: true, detail: DETAIL },
      deciding: null,
      decisionError: null,
      resolvedElsewhere: true,
    });
    expect(stillPending).toEqual({
      kind: "actionable",
      detail: DETAIL,
      deciding: null,
      error: null,
    });

    const resolved = deriveApproveCardView({
      wired: true,
      live: {
        kind: "ready",
        status: "rejected",
        canAct: true,
        detail: DETAIL,
      },
      deciding: null,
      decisionError: null,
      resolvedElsewhere: true,
    });
    expect(resolved).toEqual({
      kind: "resolved",
      status: "rejected",
      detail: DETAIL,
      resolvedElsewhere: true,
    });
  });

  test("a forbidden read cannot determine actionability or platform detail: buttons render without it, error carries through", () => {
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
    expect(view).not.toHaveProperty("detail");
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
