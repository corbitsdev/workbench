// CL-7508 review S1: a login the hub gives up on (whole-login timeout) must
// cancel the sidecar's staged listener — an abandoned pinned-port bind would
// make every retry of the connector fail to bind — and a retry must get a
// fresh, working start.
import { describe, expect, test } from "bun:test";
import {
  connectAllocated,
  createAllocatedRouter,
  parsedFrames,
  tick,
} from "./sidecar-handler.test-helpers";

function sentOAuthFrames(
  ws: { sent: string[] },
  type: "oauth.login.start" | "oauth.login.cancel",
): { requestId: string }[] {
  return parsedFrames(ws).flatMap((frame) => {
    if (
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === type &&
      "requestId" in frame &&
      typeof frame.requestId === "string"
    ) {
      return [{ requestId: frame.requestId }];
    }
    return [];
  });
}

describe("requestOAuthLogin cancellation", () => {
  test("a timed-out login sends oauth.login.cancel and a retry starts fresh", async () => {
    const router = createAllocatedRouter({
      oauthLogin: { isLocalSidecar: () => true, timeoutMs: 50 },
    });
    const ws = await connectAllocated(router);

    const firstPending = router.requestOAuthLogin({ connectorId: "codex" });
    await tick();
    const [firstStart] = sentOAuthFrames(ws, "oauth.login.start");
    const firstRequestId = firstStart?.requestId;
    if (firstRequestId === undefined) throw new Error("no start frame sent");
    // Simulate the sidecar staging the login: the started arm resolves the
    // request promise and hands back the terminal promise.
    router.handleMessage(
      ws,
      JSON.stringify({
        type: "oauth.login.result",
        requestId: firstStart?.requestId,
        outcome: { status: "started", authorizeUrl: "https://auth.example/a" },
      }),
    );
    const first = await firstPending;
    if (first.status !== "started") throw new Error("expected a started login");

    // The sidecar never sends a terminal frame, so the whole-login timeout
    // fires: the request fails and the sidecar is told to tear its
    // listener down.
    const final = await first.completed;
    if (final.status !== "error") throw new Error("expected a timeout error");
    expect(final.message).toContain("timed out");
    expect(sentOAuthFrames(ws, "oauth.login.cancel")).toEqual([
      { requestId: firstRequestId },
    ]);

    // The retry for the same connector gets a fresh start with a new
    // requestId — no stale pending entry, no wedged gate.
    const secondPending = router.requestOAuthLogin({ connectorId: "codex" });
    await tick();
    const [secondStart] = sentOAuthFrames(ws, "oauth.login.start").slice(-1);
    expect(secondStart?.requestId).not.toBe(firstRequestId);
    router.handleMessage(
      ws,
      JSON.stringify({
        type: "oauth.login.result",
        requestId: secondStart?.requestId,
        outcome: { status: "started", authorizeUrl: "https://auth.example/b" },
      }),
    );
    const second = await secondPending;
    if (second.status !== "started")
      throw new Error("expected a started retry");
    expect(sentOAuthFrames(ws, "oauth.login.start")).toHaveLength(2);
  });

  test("a completed outcome resolves the pending login with its tokens", async () => {
    const router = createAllocatedRouter({
      oauthLogin: { isLocalSidecar: () => true, timeoutMs: 5000 },
    });
    const ws = await connectAllocated(router);

    const pending = router.requestOAuthLogin({ connectorId: "codex" });
    await tick();
    const [start] = sentOAuthFrames(ws, "oauth.login.start");
    if (start === undefined) throw new Error("no start frame sent");
    router.handleMessage(
      ws,
      JSON.stringify({
        type: "oauth.login.result",
        requestId: start.requestId,
        outcome: { status: "started", authorizeUrl: "https://auth.example/a" },
      }),
    );
    const started = await pending;
    if (started.status !== "started") throw new Error("expected a started login");

    const tokens = { access: "at_1", refresh: "rt_1", expiresAt: 1750000000000 };
    router.handleMessage(
      ws,
      JSON.stringify({
        type: "oauth.login.result",
        requestId: start.requestId,
        outcome: { status: "completed", tokens },
      }),
    );
    const final = await started.completed;
    expect(final).toEqual({ status: "completed", tokens });
  });

  test("an error outcome before started settles the request as an error", async () => {
    const router = createAllocatedRouter({
      oauthLogin: { isLocalSidecar: () => true, timeoutMs: 5000 },
    });
    const ws = await connectAllocated(router);

    const pending = router.requestOAuthLogin({ connectorId: "codex" });
    await tick();
    const [start] = sentOAuthFrames(ws, "oauth.login.start");
    if (start === undefined) throw new Error("no start frame sent");
    router.handleMessage(
      ws,
      JSON.stringify({
        type: "oauth.login.result",
        requestId: start.requestId,
        outcome: { status: "error", message: "port 1455 busy" },
      }),
    );
    const outcome = await pending;
    expect(outcome).toEqual({ status: "error", message: "port 1455 busy" });
  });
});
