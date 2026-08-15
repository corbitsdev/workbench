// Mirrors packages/tasks/test/launcher.test.ts's fake-db shape, plus
// bun's module mocking for this package's own `launchFoldedRun` and
// `sendFoldedMailWithRetry` — the two free functions this module calls
// that a plain dependency object can't stub, since they're imported
// directly rather than threaded through `FoldedRunsDeps`. `@intx/hub-common`'s
// `generateId` is also mocked to a fixed id, so the launched run's
// address (`formatRunAddress(id, domain)`) is known ahead of time and
// tests can emit fake sidecar events under it.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { formatRunAddress } from "@intx/types";

const actualLaunch = await import("./launch");
const actualMail = await import("./mail");
const actualHubCommon = await import("@intx/hub-common");

let launchFoldedRunCalls = 0;
let sendFoldedMailCalls = 0;
let sendShouldFail = false;

mock.module("./launch", () => ({
  ...actualLaunch,
  launchFoldedRun: async () => {
    launchFoldedRunCalls++;
    return { instancePrincipalId: "prn_run", sessionId: "sess_1" };
  },
}));

mock.module("./mail", () => ({
  ...actualMail,
  sendFoldedMailWithRetry: async () => {
    sendFoldedMailCalls++;
    if (sendShouldFail) {
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
}));

mock.module("@intx/hub-common", () => ({
  ...actualHubCommon,
  generateId: () => "wfr_fixed_test_id",
}));

const {
  runOneShotFoldedPrompt,
  OneShotDefinitionNotFoundError,
  FoldedRunFailedError,
  FoldedRunTimedOutError,
} = await import("./one-shot-reply");

// `mock.module` replaces the module in bun's process-wide registry —
// it outlives this file's own test run and would otherwise leak into
// every other test file in the same `bun test` invocation that imports
// `./launch`, `./mail`, or `@intx/hub-common` for real behavior (e.g.
// `test/launch.test.ts`, `test/mail.test.ts`). Restore all three to
// their actual implementations once this file's tests are done.
afterAll(() => {
  mock.module("./launch", () => actualLaunch);
  mock.module("./mail", () => actualMail);
  mock.module("@intx/hub-common", () => actualHubCommon);
});

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
const TRIGGER_ADDRESS = formatRunAddress(
  "wfr_fixed_test_id",
  TENANT_ROW.domain,
);

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

function createDeps() {
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
    sendShouldFail = false;
    launchFoldedRunCalls = 0;
    sendFoldedMailCalls = 0;
    const fake = createFakeEmitter();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const { lifecycle, tracked, activity, untracked } = createFakeLifecycle();
    const deps = {
      ...createDeps(),
      events: fake.emitter,
      undeploy,
      lifecycle,
    } as never;

    const promise = runOneShotFoldedPrompt(deps, INPUT);

    // Let the async launch+send chain settle before emitting events.
    await new Promise((r) => setTimeout(r, 10));
    fake.emit("agent.event", {
      agentAddress: "some-other-address",
      event: { type: "connector.reply", data: { content: "ignored" } },
    });
    fake.emit("agent.event", {
      agentAddress: TRIGGER_ADDRESS,
      event: { type: "connector.reply", data: { content: "Hello " } },
    });
    fake.emit("agent.event", {
      agentAddress: TRIGGER_ADDRESS,
      event: { type: "connector.reply", data: { content: "world" } },
    });
    fake.emit("agent.event", {
      agentAddress: TRIGGER_ADDRESS,
      event: { type: "message.run.ended", data: { status: "completed" } },
    });

    const result = await promise;
    expect(result.content).toBe("Hello world");
    expect(result.runId).toBe("wfr_fixed_test_id");
    expect(launchFoldedRunCalls).toBe(1);
    expect(sendFoldedMailCalls).toBe(1);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: TRIGGER_ADDRESS, reason: "planning-run-complete" },
    ]);
    expect(tracked).toEqual([TRIGGER_ADDRESS]);
    expect(activity).toEqual([TRIGGER_ADDRESS]);
    expect(untracked).toEqual([TRIGGER_ADDRESS]);
  });

  test("a failed run rejects with FoldedRunFailedError, unsubscribes, and tears the run down", async () => {
    sendShouldFail = false;
    const fake = createFakeEmitter();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createDeps(),
      events: fake.emitter,
      undeploy,
    } as never;

    const promise = runOneShotFoldedPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    fake.emit("agent.event", {
      agentAddress: TRIGGER_ADDRESS,
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "boom" } },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(FoldedRunFailedError);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: TRIGGER_ADDRESS, reason: "planning-run-failed" },
    ]);
  });

  test("an unknown definition throws OneShotDefinitionNotFoundError", async () => {
    const fake = createFakeEmitter();
    const { undeploy } = createFakeUndeploy();
    const deps = {
      ...createDeps(),
      events: fake.emitter,
      undeploy,
      foldedRuns: {
        ...createDeps().foldedRuns,
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
    sendShouldFail = false;
    const fake = createFakeEmitter();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const base = createDeps();
    const deps = {
      ...base,
      cryptoProviders: {
        get() {
          return Promise.reject(new Error("cipher unavailable"));
        },
      },
      events: fake.emitter,
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

    // The real cause propagates directly, well before the timeout.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("cipher unavailable");
    expect(elapsed).toBeLessThan(300);
    expect(undeployCalls).toEqual([
      { address: TRIGGER_ADDRESS, reason: "planning-run-send-failed" },
    ]);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });
});

describe("timeout tears the launched run down", () => {
  test("a timeout unsubscribes AND undeploys the run it launched, before rejecting", async () => {
    sendShouldFail = false;
    launchFoldedRunCalls = 0;
    const fake = createFakeEmitter();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createDeps(),
      events: fake.emitter,
      undeploy,
    } as never;

    await expect(
      runOneShotFoldedPrompt(deps, { ...INPUT, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(FoldedRunTimedOutError);

    // A run WAS launched (workflow_run row + deployed sidecar instance)...
    expect(launchFoldedRunCalls).toBe(1);
    // ...the listener is gone...
    expect(fake.listenerCount("agent.event")).toBe(0);
    // ...and the launched run was torn down, not left running.
    expect(undeployCalls).toEqual([
      { address: TRIGGER_ADDRESS, reason: "planning-run-timed-out" },
    ]);
  });
});
