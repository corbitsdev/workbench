// Mirrors packages/tasks/test/launcher.test.ts's fake-db shape, plus
// bun's module mocking for `@corbits/folded-runs`' `launchFoldedRun`
// and `sendFoldedMailWithRetry` — the two free functions this module
// calls that a plain dependency object can't stub, since they're
// imported directly rather than threaded through `FoldedRunsDeps`.
// `@intx/hub-common`'s `generateId` is also mocked to a fixed id, so
// the launched run's address (`formatRunAddress(id, domain)`) is
// known ahead of time and tests can emit fake sidecar events under it.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { formatRunAddress } from "@intx/types";

const actualFoldedRuns = await import("@corbits/folded-runs");
const actualHubCommon = await import("@intx/hub-common");

let launchFoldedRunCalls = 0;
let sendFoldedMailCalls = 0;
let sendShouldFail = false;

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  launchFoldedRun: async () => {
    launchFoldedRunCalls++;
    return { instancePrincipalId: "prn_run", sessionId: "sess_1" };
  },
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
  PlannerRunFailedError,
  PlannerRunTimedOutError,
} = await import("./one-shot-reply");

// `mock.module` replaces the module in bun's process-wide registry —
// it outlives this file's own test run and would otherwise leak into
// every other test file in the same `bun test` invocation that
// imports `@corbits/folded-runs` or `@intx/hub-common` for real
// behavior (e.g. `spawn.test.ts`, which needs the real
// `launchFoldedRun`/`sendFoldedMailWithRetry` to exercise
// `@corbits/tasks`' own `launchTask`). Restore both modules to their
// actual implementations once this file's tests are done.
afterAll(() => {
  mock.module("@corbits/folded-runs", () => actualFoldedRuns);
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
  test("happy path resolves with accumulated reply content and the run id", async () => {
    sendShouldFail = false;
    launchFoldedRunCalls = 0;
    sendFoldedMailCalls = 0;
    const fake = createFakeEmitter();
    const deps = { ...createDeps(), events: fake.emitter } as never;

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
  });

  test("a failed run rejects with PlannerRunFailedError and unsubscribes", async () => {
    sendShouldFail = false;
    const fake = createFakeEmitter();
    const deps = { ...createDeps(), events: fake.emitter } as never;

    const promise = runOneShotFoldedPrompt(deps, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    fake.emit("agent.event", {
      agentAddress: TRIGGER_ADDRESS,
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "boom" } },
      },
    });

    await expect(promise).rejects.toBeInstanceOf(PlannerRunFailedError);
    expect(fake.listenerCount("agent.event")).toBe(0);
  });

  test("a timeout rejects with PlannerRunTimedOutError, unsubscribes, and a late event is a no-op", async () => {
    sendShouldFail = false;
    const fake = createFakeEmitter();
    const deps = { ...createDeps(), events: fake.emitter } as never;

    const promise = runOneShotFoldedPrompt(deps, { ...INPUT, timeoutMs: 20 });

    await expect(promise).rejects.toBeInstanceOf(PlannerRunTimedOutError);
    expect(fake.listenerCount("agent.event")).toBe(0);

    // A late-firing event after timeout must not throw or resolve twice.
    expect(() =>
      fake.emit("agent.event", {
        agentAddress: TRIGGER_ADDRESS,
        event: { type: "message.run.ended", data: { status: "completed" } },
      }),
    ).not.toThrow();
  });

  test("an unknown definition throws OneShotDefinitionNotFoundError", async () => {
    const fake = createFakeEmitter();
    const deps = {
      ...createDeps(),
      events: fake.emitter,
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
