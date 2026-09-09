// `provision` and `sendMail` are stubbed via `OneShotRunnerDeps`' own
// test seam (a plain injected override), NOT `mock.module`.
import { describe, expect, test } from "bun:test";

import {
  OneShotDefinitionNotFoundError,
  OneShotRunFailedError,
  OneShotRunTimedOutError,
  OneShotRunUnreachableError,
  runOneShotPrompt,
} from "./one-shot-prompt";

/** Asserts a fake's call list recorded at least one call and returns the
 * first — avoids a non-null assertion at every `calls[0]` read below. */
function firstCall<T>(calls: readonly T[]): T {
  const [call] = calls;
  if (call === undefined) throw new Error("expected at least one call");
  return call;
}

// The inert projection the deploy freeze persists onto the definition's
// version row — the launch body's only hub-side source under the
// `workflow.json` retirement.
const AGENT_WIRE_PROJECTION = {
  id: "wfd_planner",
  triggers: [],
  stepOrder: ["agent"],
  steps: {
    agent: {
      kind: "step",
      agent: {
        systemPrompt: "You are Myra.",
        modelSources: [
          { provider: "anthropic", model: "declared-default-model" },
        ],
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

/** A `db` double covering both the row reads and the drizzle
 * `select().from().where().limit()` chain `loadFrozenWireProjection`
 * runs for the version row's stored projection. */
function fakeDb() {
  return {
    query: {
      workflowDefinition: { findFirst: async () => DEFINITION_ROW },
      tenant: { findFirst: async () => TENANT_ROW },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ wireProjection: AGENT_WIRE_PROJECTION }],
        }),
      }),
    }),
  };
}

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

/** A fake `provision`: records every call, always succeeds, and
 * returns a stable address so a test can emit sidecar events for it. */
function createFakeProvision() {
  const calls: { address: string; runId: string }[] = [];
  return {
    calls,
    provision: async () => {
      const runId = "run_1";
      const address = `${runId}@acme.example`;
      calls.push({ address, runId });
      return { runId, address, sessionId: "sess_1" };
    },
  };
}

/** A fake `sendMail`: records every call. A test scripts per-attempt
 * failures by 1-based attempt number in `throwOn`; every other attempt
 * succeeds. */
function createFakeSend(throwOn: Record<number, Error> = {}): {
  calls: number;
  sendMail: (...args: unknown[]) => Promise<void>;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    sendMail: async () => {
      calls++;
      const thrown = throwOn[calls];
      if (thrown !== undefined) throw thrown;
    },
  };
}

/** A tiny fake `undeploy` port recording every call it received. */
function createFakeUndeploy() {
  const calls: { address: string; reason: string }[] = [];
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
    db: fakeDb(),
    repoStore: { resolveRef: async () => "sha_test" },
    workflowAllocationService: {},
    sessionService: {},
    isRoutable: () => true,
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

describe("runOneShotPrompt", () => {
  test("happy path resolves with accumulated reply content, tears the run down, and untracks it", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const fakeSend = createFakeSend();
    const { sendMail } = fakeSend;
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const { lifecycle, tracked, activity, untracked } = createFakeLifecycle();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail,
      undeploy,
      lifecycle,
    } as never;

    const promise = runOneShotPrompt(deps, INPUT);

    // Let the async launch+send chain settle before emitting events.
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = firstCall(launchCalls).address;
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
    expect(result.runId).toBe(firstCall(launchCalls).runId);
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

  test("a failed run rejects with OneShotRunFailedError, unsubscribes, and tears the run down", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const { sendMail } = createFakeSend();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail,
      undeploy,
    } as never;

    const promise = runOneShotPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = firstCall(launchCalls).address;

    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "boom" } },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(OneShotRunFailedError);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-failed" },
    ]);
  });

  test("an unknown definition throws OneShotDefinitionNotFoundError", async () => {
    const fake = createFakeEmitter();
    const { provision } = createFakeProvision();
    const { sendMail } = createFakeSend();
    const { undeploy } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail,
      undeploy,
      db: {
        query: {
          workflowDefinition: { findFirst: async () => undefined },
          tenant: { findFirst: async () => TENANT_ROW },
        },
      },
    } as never;

    await expect(runOneShotPrompt(deps, INPUT)).rejects.toBeInstanceOf(
      OneShotDefinitionNotFoundError,
    );
  });
});

describe("send-path throw (not an !ok result)", () => {
  test("a throwing cryptoProviders.get is caught, torn down, and rejects promptly with the real cause", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const { sendMail } = createFakeSend();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      cryptoProviders: {
        get() {
          return Promise.reject(new Error("cipher unavailable"));
        },
      },
      events: fake.emitter,
      provision,
      sendMail,
      undeploy,
    } as never;

    const started = Date.now();
    let caught: unknown;
    try {
      await runOneShotPrompt(deps, { ...INPUT, timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - started;
    const triggerAddress = firstCall(launchCalls).address;

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
    const { provision, calls: launchCalls } = createFakeProvision();
    const { sendMail } = createFakeSend();
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail,
      undeploy,
    } as never;

    await expect(
      runOneShotPrompt(deps, { ...INPUT, timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(OneShotRunTimedOutError);
    const triggerAddress = firstCall(launchCalls).address;

    expect(launchCalls).toHaveLength(1);
    expect(fake.listenerCount("agent.event")).toBe(0);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-timed-out" },
    ]);
  });
});

// The bounded-wait mechanics these tests exercise are documented on
// `OneShotRunnerDeps.isRoutable` — that JSDoc is the authoritative
// telling; the tests below pin the observable behavior.
describe("routable wait on the opening send", () => {
  const UNREACHABLE = new Error("agent is unreachable: run_1@acme.example");

  test("retries the opening send right away when the address is routable after the first failure", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const send = createFakeSend({ 1: UNREACHABLE });
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail: send.sendMail,
      undeploy,
      // Routable from the first consult on — no polling, one retry.
      isRoutable: () => send.calls >= 1,
    } as never;

    const promise = runOneShotPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = firstCall(launchCalls).address;

    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "connector.reply", data: { content: "Hello" } },
    });
    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "message.run.ended", data: { status: "completed" } },
    });

    const result = await promise;
    expect(result.content).toBe("Hello");
    expect(send.calls).toBe(2);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-complete" },
    ]);
  });

  test("rejects OneShotRunUnreachableError when the routable wait expires", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const send = createFakeSend({ 1: UNREACHABLE, 2: UNREACHABLE });
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail: send.sendMail,
      undeploy,
      isRoutable: () => false,
      deliverWait: {
        deadlineMs: 50,
        pollIntervalMs: 5,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
    } as never;

    let caught: unknown;
    try {
      await runOneShotPrompt(deps, INPUT);
    } catch (err) {
      caught = err;
    }
    const triggerAddress = firstCall(launchCalls).address;

    expect(caught).toBeInstanceOf(OneShotRunUnreachableError);
    expect((caught as OneShotRunUnreachableError).cause).toBe(UNREACHABLE);
    // `deliverWhenRoutable` sends once, polls, and gives up at the
    // deadline without ever reaching its second send.
    expect(send.calls).toBe(1);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-send-unreachable" },
    ]);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });

  test("routable mid-wait: flips true after several polls and the retried send completes", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const send = createFakeSend({ 1: UNREACHABLE });
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    let routabilityChecks = 0;
    const routabilityAddresses: string[] = [];
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail: send.sendMail,
      undeploy,
      isRoutable: (address: string) => {
        routabilityChecks++;
        routabilityAddresses.push(address);
        return routabilityChecks > 3;
      },
      deliverWait: {
        deadlineMs: 5_000,
        pollIntervalMs: 1,
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
    } as never;

    const promise = runOneShotPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const triggerAddress = firstCall(launchCalls).address;

    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "connector.reply", data: { content: "Hello" } },
    });
    fake.emit("agent.event", {
      agentAddress: triggerAddress,
      event: { type: "message.run.ended", data: { status: "completed" } },
    });

    const result = await promise;
    expect(result.content).toBe("Hello");
    expect(routabilityChecks).toBeGreaterThan(3);
    // The launched run's address, not some placeholder, is what the
    // runner consults.
    expect(routabilityAddresses).toContain(triggerAddress);
    expect(send.calls).toBe(2);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-complete" },
    ]);
  });

  test("the reply timer wins over the routable wait and no send follows the teardown", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const send = createFakeSend({ 1: UNREACHABLE });
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail: send.sendMail,
      undeploy,
      isRoutable: () => false,
      deliverWait: {
        deadlineMs: 5_000,
        pollIntervalMs: 5,
        // Cooperative: yields to macrotasks so the reply timer can fire
        // mid-wait (a noop sleep would starve it).
        sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      },
    } as never;

    let caught: unknown;
    try {
      await runOneShotPrompt(deps, { ...INPUT, timeoutMs: 50 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(OneShotRunTimedOutError);
    const triggerAddress = firstCall(launchCalls).address;
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-timed-out" },
    ]);
    // Let any post-teardown send attempt surface before pinning the count.
    await new Promise((r) => setTimeout(r, 20));
    expect(send.calls).toBeLessThanOrEqual(1);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });

  test("a non-unreachable send error is not retried and rejects with the original cause", async () => {
    const fake = createFakeEmitter();
    const { provision, calls: launchCalls } = createFakeProvision();
    const original = new Error("cipher unavailable");
    const send = createFakeSend({ 1: original });
    const { undeploy, calls: undeployCalls } = createFakeUndeploy();
    const deps = {
      ...createBaseDeps(),
      events: fake.emitter,
      provision,
      sendMail: send.sendMail,
      undeploy,
    } as never;

    let caught: unknown;
    try {
      await runOneShotPrompt(deps, INPUT);
    } catch (err) {
      caught = err;
    }
    const triggerAddress = firstCall(launchCalls).address;

    expect(caught).toBe(original);
    expect(send.calls).toBe(1);
    expect(undeployCalls).toEqual([
      { address: triggerAddress, reason: "planning-run-send-failed" },
    ]);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });
});
