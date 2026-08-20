// Covers the fail-closed registry surfaces and the capability- and
// ledger-checked action invoker, including durable dedupe through the
// workflow-run effect ledger.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";
import {
  createRepoStore,
  type AuthorizeFn,
  type KindHandler,
  type Principal,
  type RepoId,
  type ValidatePushResult,
} from "@intx/hub-sessions";
import type { EffectLedger, WorkflowAuthorizeFn } from "@intx/workflow";

import {
  createActionHandlerRegistry,
  createLoopFnRegistry,
  createWorkflowActionInvoker,
  type ActionHandler,
} from "./action-invoker";
import { createWorkflowRunEffectLedger } from "./effect-ledger";

function inMemoryLedger(): EffectLedger {
  const store = new Map<string, { output: unknown }>();
  return {
    async lookup(effectKey) {
      return store.get(effectKey);
    },
    async record(effectKey, output) {
      store.set(effectKey, { output });
    },
  };
}

const allowAll: WorkflowAuthorizeFn = async () => ({
  effect: "allow",
  matchingGrants: [],
  resolvedBy: null,
});

const denyAll: WorkflowAuthorizeFn = async () => ({
  effect: "deny",
  matchingGrants: [],
  resolvedBy: null,
});

describe("createWorkflowActionInvoker", () => {
  test("runs the resolved handler and returns its output", async () => {
    const handler: ActionHandler = async (input) => {
      return { echoed: input };
    };
    const invoker = createWorkflowActionInvoker({
      authorize: allowAll,
      effects: inMemoryLedger(),
      resolveHandler: createActionHandlerRegistry({ "echo.handler": handler }),
    });
    const result = await invoker({
      handler: "echo.handler",
      input: { n: 3 },
      requires: [],
      authzContext: { runId: "r1", stepId: "s1", attempt: 1 },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ output: { echoed: { n: 3 } } });
  });

  test("unknown handler ref fails closed", async () => {
    const invoker = createWorkflowActionInvoker({
      authorize: allowAll,
      effects: inMemoryLedger(),
      resolveHandler: createActionHandlerRegistry({}),
    });
    await expect(
      invoker({
        handler: "missing.handler",
        input: null,
        requires: [],
        authzContext: { runId: "r1", stepId: "s1", attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/unknown action handler/);
  });

  test("perform: undeclared capability fails closed", async () => {
    const handler: ActionHandler = async (_input, ctx) =>
      ctx.perform({
        effectId: "x",
        capability: "not.declared",
        run: async () => "should-not-run",
      });
    const invoker = createWorkflowActionInvoker({
      authorize: allowAll,
      effects: inMemoryLedger(),
      resolveHandler: createActionHandlerRegistry({ "cap.handler": handler }),
    });
    await expect(
      invoker({
        handler: "cap.handler",
        input: null,
        requires: ["other.cap"],
        authzContext: { runId: "r1", stepId: "s1", attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/not in its declared requires set/);
  });

  test("perform: authorize deny fails closed", async () => {
    const handler: ActionHandler = async (_input, ctx) =>
      ctx.perform({
        effectId: "x",
        capability: "side.effect",
        run: async () => "should-not-run",
      });
    const invoker = createWorkflowActionInvoker({
      authorize: denyAll,
      effects: inMemoryLedger(),
      resolveHandler: createActionHandlerRegistry({ "authz.handler": handler }),
    });
    await expect(
      invoker({
        handler: "authz.handler",
        input: null,
        requires: ["side.effect"],
        authzContext: { runId: "r1", stepId: "s1", attempt: 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/was not authorized/);
  });
});

describe("createWorkflowActionInvoker + durable ledger via perform", () => {
  const tempDirs: string[] = [];
  let signingKey: KeyPair;

  const permissiveHandler: KindHandler = {
    kind: "agent-state",
    directoryPrefix: "action-invoker-ledger-test",
    validatePush(): ValidatePushResult {
      return { ok: true };
    },
    onRefUpdated() {
      /* no-op */
    },
  };

  const substrateAllow: AuthorizeFn = () => ({ allowed: true });
  const principal: Principal = { kind: "test" };
  const REF = "refs/heads/main";

  beforeAll(async () => {
    signingKey = await generateKeyPair();
  });

  afterAll(async () => {
    for (const d of tempDirs.splice(0)) {
      await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {
        /* best effort */
      });
    }
  });

  async function makeDurableLedger(runId: string) {
    const dataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "action-invoker-ledger-"),
    );
    tempDirs.push(dataDir);
    const repoId: RepoId = { kind: "agent-state", id: `dep-${runId}` };
    const substrate = createRepoStore({
      dataDir,
      signingKey,
      handlers: { "agent-state": permissiveHandler },
      authorize: substrateAllow,
    });
    const effects = createWorkflowRunEffectLedger({
      substrate,
      repoId,
      principal,
      runId,
      ref: REF,
    });
    return { effects, substrate, repoId };
  }

  test("ctx.perform records once; second invoker call returns ledger hit without re-running", async () => {
    let runs = 0;
    const handler: ActionHandler = async (_input, ctx) =>
      ctx.perform({
        effectId: "side-effect",
        capability: "test.effect",
        run: async () => {
          runs += 1;
          return { n: runs };
        },
      });

    const { effects, substrate, repoId } =
      await makeDurableLedger("run-dedupe");
    const resolveHandler = createActionHandlerRegistry({
      "dedupe.handler": handler,
    });
    const invoker = createWorkflowActionInvoker({
      authorize: allowAll,
      effects,
      resolveHandler,
    });
    const call = {
      handler: "dedupe.handler",
      input: { x: 1 },
      requires: ["test.effect"] as const,
      authzContext: { runId: "run-dedupe", stepId: "s1", attempt: 1 },
      signal: new AbortController().signal,
    };

    const first = await invoker(call);
    expect(first).toEqual({ output: { n: 1 } });
    expect(runs).toBe(1);

    // Fresh invoker + ledger against the same substrate — simulates a child
    // restart that rebuilds adapters after the effect was already recorded.
    const restarted = createWorkflowActionInvoker({
      authorize: allowAll,
      effects: createWorkflowRunEffectLedger({
        substrate,
        repoId,
        principal,
        runId: "run-dedupe",
        ref: REF,
      }),
      resolveHandler,
    });
    const second = await restarted(call);
    expect(second).toEqual({ output: { n: 1 } });
    expect(runs).toBe(1);
  });
});

describe("createLoopFnRegistry", () => {
  test("resolves a registered pure fn", () => {
    const registry = createLoopFnRegistry({
      "while.under": (out) => (out as { n: number }).n < 3,
      "carry.inc": (out) => {
        const n = (out as { n: number }).n;
        return { n: n + 1 };
      },
    });
    expect(registry("while.under")({ n: 1 }, null)).toBe(true);
    expect(registry("carry.inc")({ n: 1 }, null)).toEqual({ n: 2 });
  });

  test("unknown loop fn fails closed", () => {
    const registry = createLoopFnRegistry({});
    expect(() => registry("missing.fn")).toThrow(/unknown loop fn/);
  });
});
