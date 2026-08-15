// Mirrors packages/tasks/test/launcher.test.ts's fake-db shape.
// `launchFoldedRun` and `sendFoldedMailWithRetry` — the two free
// functions this module calls directly rather than threading through
// `FoldedRunsDeps` — are stubbed via `OneShotRunnerDeps`' own
// `launchFoldedRun`/`sendFoldedMailWithRetry` test seam (a plain
// injected override), NOT `mock.module`: `test/launch.test.ts` and
// `test/mail.test.ts`, this package's own tests for those two
// modules, both dynamically import the exact files a
// `mock.module("./launch", ...)`/`mock.module("./mail", ...)` here
// would replace, in the same `bun test` process — a shared-registry
// collision a plain injected fake sidesteps entirely.
import { describe, expect, test } from "bun:test";

import {
  runOneShotFoldedPrompt,
  OneShotDefinitionNotFoundError,
  FoldedRunFailedError,
  FoldedRunTimedOutError,
} from "./one-shot-reply";

const AGENT_WORKFLOW_JSON = {
  id: "wfd_planner",
  stepOrder: ["agent"],
  steps: {
    agent: {
      kind: "step",
      agent: {
        systemPrompt: "You are Myra.",
        inference: { sources: [{ model: "declared-default-model" }] },
      },
    },
  },
};

const DEFINITION_ROW = {
  id: "wfd_planner",
  tenantId: "tnt_1",
  status: "deployed",
  assetId: "ast_1",
  name: "assistant",
};
const TENANT_ROW = { id: "tnt_1", domain: "acme.example" };

/** A tiny fake `SidecarEventEmitter` — a `Map` of listener sets plus an
 * `.emit()` test helper mimicking the real emitter's `on`/`emit` shape. */
function createFakeEmitter() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emitter: {
      on(type: string, listener: (payload: unknown) => void) {
        let set = listeners.get(type);
        if (set === undefined) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
        return () => {
          set?.delete(listener);
        };
      },
    } as never,
    emit(type: string, payload: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(payload);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** A fake `launchFoldedRun`: records every call, always "succeeds," and
 * captures the `triggerAddress` it was launched under so a test can
 * emit fake sidecar events for that exact address without needing to
 * predict the real (randomly generated) instance id. */
function createFakeLaunch() {
  const calls: Array<{ triggerAddress: string; instanceId: string }> = [];
  return {
    calls,
    launchFoldedRun: async (
      _foldedRuns: unknown,
      params: { triggerAddress: string; instanceId: string },
    ) => {
      calls.push({
        triggerAddress: params.triggerAddress,
        instanceId: params.instanceId,
      });
      return { instancePrincipalId: "prn_run", sessionId: "sess_1" };
    },
  };
}

/** A fake `sendFoldedMailWithRetry`: records every call and either
 * succeeds, returns an `!ok` result, or throws — controlled per test. */
function createFakeSend(
  behavior: "ok" | "not-ok" | "throws" = "ok",
): {
  calls: number;
  sendFoldedMailWithRetry: (
    ...args: unknown[]
  ) => Promise<{ ok: true; mail: unknown } | { ok: false; error: Error; attempts: number }>;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    sendFoldedMailWithRetry: async () => {
      calls++;
      if (behavior === "throws") {
        throw new Error("cipher unavailable");
      }
      if (behavior === "not-ok") {
        return {
          ok: false as const,
          error: new Error("send failed"),
          attempts: 3,
        };
      }
      return {
        ok: true as const,
        mail: { id: "mail_1", createdAt: new Date().toISOString() },
      };
    },
  };
}

/** A tiny fake `undeploy` port recording every call it received. */
function createFakeUndeploy() {
  const calls: Array<{ address: string; reason: string }> = [];
  return {
    calls,
    undeploy: async (address: string, reason: string) => {
      calls.push({ address, reason });
    },
  };
}

/** A tiny fake `lifecycle` recording track/recordActivity/untrack calls. */
function createFakeLifecycle() {
  const tracked: string[] = [];
  const activity: string[] = [];
  const untracked: string[] = [];
  return {
    tracked,
    activity,
    untracked,
    lifecycle: {
      track: (address: string) => {
        tracked.push(address);
      },
      recordActivity: (address: string) => {
        activity.push(address);
      },
      untrack: (address: string) => {
        untracked.push(address);
      },
    },
  };
}

function createBaseDeps() {
  return {
    foldedRuns: {
      db: {
        query: {
          workflowDefinition: { findFirst: async () => DEFINITION_ROW },
          tenant: { findFirst: async () => TENANT_ROW },
        },
      },
      assetService: {
        async readAssetBlob() {
          return new TextEncoder().encode(JSON.stringify(AGENT_WORKFLOW_JSON));
        },
      },
      sessionService: {},
      sidecarRouter: {},
      eventCollectors: {},
    },
    cryptoProviders: {
      async get() {
        return {};
      },
    },
  };
}

const INPUT = {
  tenantId: "tnt_1",
  principalId: "prn_alice",
  definitionId: "wfd_planner",
  prompt: "Plan this outcome.",
  timeoutMs: 200,
};

describe("runOneShotFoldedPrompt", () => {
  test("happy path resolves with accumulated reply content, tears the run down, and untracks it", async () => {
    const fake = createFakeEmitter();
    const { launchFoldedRun, calls: launchCalls } = createFakeLaunch();
    const fakeSend = createFakeSend("ok");
    const { sendFoldedMailWithRetry } = fakeSend;
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const { lifecycle, tracked, activity, untracked } = createFakeLifecycle();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      launchFoldedRun,
      sendFoldedMailWithRetry,
      undeploy,
      lifecycle,
    } as never;

    const promise = runOneShotFoldedPrompt(deps, INPUT);

    // Let the async launch+send chain settle before emitting events.
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = launchCalls[0]!.triggerAddress;
    expect(triggerAddress).toBeTruthy();

    fake.emit("agent.event", {
      agentAddress: "some-other-address",
      event: { type: "connector.reply", data: { content: "ignored" } },
    });
    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "connector.reply", data: { content: "Hello " } },
    });
    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "connector.reply", data: { content: "world" } },
    });
    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "message.run.ended", data: { status: "completed" } },
    });

    const result = await promise;
    expect(result.content).toBe("Hello world");
    expect(result.runId).toBe(launchCalls[0]!.instanceId);
    expect(launchCalls).toHaveLength(1);
    expect(fakeSend.calls).toBe(1);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-complete" },
    ]);
    expect(tracked).toEqual([triggerAddress]);
    expect(activity).toEqual([triggerAddress]);
    expect(untracked).toEqual([triggerAddress]);
  });

  test("a failed run rejects with FoldedRunFailedError, unsubscribes, and tears the run down", async () => {
    const fake = createFakeEmitter();
    const { launchFoldedRun, calls: launchCalls } = createFakeLaunch();
    const { sendFoldedMailWithRetry } = createFakeSend("ok");
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      launchFoldedRun,
      sendFoldedMailWithRetry,
      undeploy,
    } as never;

    const promise = runOneShotFoldedPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = launchCalls[0]!.triggerAddress;

    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "boom" } },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(FoldedRunFailedError);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-failed" },
    ]);
  });

  test("an unknown definition throws OneShotDefinitionNotFoundError", async () => {
    const fake = createFakeEmitter();
    const { launchFoldedRun } = createFakeLaunch();
    const { sendFoldedMailWithRetry } = createFakeSend("ok");
    const { undeploy } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      launchFoldedRun,
      sendFoldedMailWithRetry,
      undeploy,
      foldedRuns: {
        ...createBaseDeps().foldedRuns,
        db: {
          query: {
            workflowDefinition: { findFirst: async () => undefined },
            tenant: { findFirst: async () => TENANT_ROW },
          },
        },
      },
    } as never;

    await expect(runOneShotFoldedPrompt(deps, INPUT)).rejects.toBeInstanceOf(
      OneShotDefinitionNotFoundError,
    );
  });
});

describe("send-path throw (not an !ok result)", () => {
  test("a throwing cryptoProviders.get is caught, torn down, and rejects promptly with the real cause", async () => {
    const fake = createFakeEmitter();
    const { launchFoldedRun, calls: launchCalls } = createFakeLaunch();
    const { sendFoldedMailWithRetry } = createFakeSend("ok");
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      cryptoProviders: {
        get() {
          return Promise.reject(new Error("cipher unavailable"));
        },
      },
      events: fake.emitter,
      launchFoldedRun,
      sendFoldedMailWithRetry,
      undeploy,
    } as never;

    const started = Date.now();
    let caught: unknown;
    try {
      await runOneShotFoldedPrompt(deps, { ...INPUT, timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    const triggerAddress = launchCalls[0]!.triggerAddress;

    // The real cause propagates directly, well before the timeout.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("cipher unavailable");
    expect(elapsed).toBeLessThan(300);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-send-failed" },
    ]);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });
});

describe("timeout tears the launched run down", () => {
  test("a timeout unsubscribes AND undeploys the run it launched, before rejecting", async () => {
    const fake = createFakeEmitter();
    const { launchFoldedRun, calls: launchCalls } = createFakeLaunch();
    const { sendFoldedMailWithRetry } = createFakeSend("ok");
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      launchFoldedRun,
      sendFoldedMailWithRetry,
      undeploy,
    } as never;

    await expect(
      runOneShotFoldedPrompt(deps, { ...INPUT, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(FoldedRunTimedOutError);
    const triggerAddress = launchCalls[0]!.triggerAddress;

    // A run WAS launched (workflow_run row + deployed sidecar instance)...
    expect(launchCalls).toHaveLength(1);
    // ...the listener is gone...
    expect(fake.listenerCount("agent.event")).toBe(0);
    // ...and the launched run was torn down, not left running.
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-timed-out" },
    ]);
  });
});
