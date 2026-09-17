// The finishing-setup step used to poll `/api/setup/complete` in an
// unbounded loop: a stalled bench kept the person on a spinner forever.
// Every case here pins the bound — the poll coasts while agents are
// pending, stops after the attempt cap, and an unmount cancels cleanly.

import { describe, expect, test } from "bun:test";

import {
  type CompleteSetupOutcome,
  waitForSetupCompletion,
} from "./onboarding";

const connectedPending: CompleteSetupOutcome = {
  kind: "connected",
  tenantSlug: "acme",
  agentsPending: true,
  steps: [],
};

const connectedReady: CompleteSetupOutcome = {
  kind: "connected",
  tenantSlug: "acme",
  agentsPending: false,
};

describe("waitForSetupCompletion", () => {
  test("a tenant that is already seeded returns its answer without polling again", async () => {
    let calls = 0;
    const settled = await waitForSetupCompletion(
      async () => {
        calls += 1;
        return connectedReady;
      },
      { delayMs: 0 },
    );
    expect(settled).toEqual(connectedReady);
    expect(calls).toBe(1);
  });

  test("a tenant finishing its seed is re-polled until the agents land", async () => {
    const seen: CompleteSetupOutcome[] = [];
    let calls = 0;
    const settled = await waitForSetupCompletion(
      async () => {
        calls += 1;
        return calls < 3 ? connectedPending : connectedReady;
      },
      {
        delayMs: 0,
        onPolling: (outcome) => {
          seen.push(outcome);
        },
      },
    );
    expect(settled).toEqual(connectedReady);
    expect(calls).toBe(3);
    expect(seen).toEqual([connectedPending, connectedPending]);
  });

  test("a stalled bench stops after the attempt cap and hands back the last answer", async () => {
    let calls = 0;
    const settled = await waitForSetupCompletion(
      async () => {
        calls += 1;
        return connectedPending;
      },
      { maxAttempts: 3, delayMs: 0 },
    );
    expect(calls).toBe(3);
    expect(settled).toEqual({
      kind: "timeout",
      attempts: 3,
      lastOutcome: connectedPending,
    });
  });

  test("unmounting mid-poll settles as cancelled instead of navigating later", async () => {
    let calls = 0;
    const settled = await waitForSetupCompletion(
      async () => {
        calls += 1;
        return connectedPending;
      },
      { maxAttempts: 20, delayMs: 0, isCancelled: () => calls >= 2 },
    );
    expect(settled).toEqual({ kind: "cancelled" });
  });
});
