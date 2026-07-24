import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { hexDecode, hexEncode } from "@intx/types";
import { createInMemoryTransport } from "@intx/mail-memory";
import type { RepoId, RepoStore } from "@workbench/hub-sessions";
import {
  createControlChannelSender,
  createEventChannelSender,
  type EventPayload,
  type FrameReader,
  type NdjsonReader,
  type NdjsonWriter,
  type SubprocessHandle,
  type SubprocessSpawner,
} from "@workbench/workflow-host";
import type { AgentDeployFrame } from "@intx/types/sidecar";
import type { InferenceEvent as WireInferenceEvent } from "@intx/types/runtime";
import { assistantLoopInterruptMessage } from "@workbench/hub-agent";

import {
  computeWireDefinitionHash,
  createPidTrackingRssReader,
  createSidecarDeployRouter,
  createSidecarWorkflowSupervisor,
  DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES,
  deriveDeploymentId,
  RAW_DEPLOYMENT_ID_ENV_KEY,
  recyclePolicyWantsRssTracking,
  resolveDefaultRecyclePolicy,
  STEP_INFERENCE_SOURCES_ENV_KEY,
  validateWorkflowProjection,
} from "./workflow-host-wiring";
import {
  createMultistepMailRouter,
  createMultistepSourcesRouter,
  type MultistepMailRouter,
  type MultistepSourcesRouter,
} from "./workflow-run-pack-client";

function createMinimalStubRepoStore(): RepoStore {
  const stub: Partial<RepoStore> = {
    getRepoDir(_repoId: RepoId): string {
      return "/tmp/unused";
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      // The wiring test exercises signature attribution by driving a
      // requestCancel; the merge callback runs once with an empty
      // pre-image.
      await args.merge(new Map());
      return { commitSha: "stub-sha", newlyTerminalRuns: [] };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; the wiring test exercises only getRepoDir + writeTreePreservingPrefix
  return new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(
          `stub RepoStore: ${String(prop)} not implemented for this test`,
        );
      };
    },
  });
}

describe("createSidecarWorkflowSupervisor", () => {
  test("constructs the supervisor with the sidecar's bindings and signs CancelRequested via the host's signing key", async () => {
    const transport = createInMemoryTransport();
    const keyPair = await generateKeyPair();
    const repoStore = createMinimalStubRepoStore();

    const spawner: SubprocessSpawner = () => {
      throw new Error("spawner not invoked in this test");
    };

    const wired = createSidecarWorkflowSupervisor({
      transport,
      repoStore,
      signingKeySeed: keyPair.privateKey,
      workflowRunRepoId: { kind: "workflow-run", id: "wire-test" },
      workflowRunRef: "refs/heads/main",
      deploymentId: "wire-test",
      stepCount: 1,
      deploymentMailAddress: "wire-test@example.com",
      deriveStepAddress: ({ deploymentId, stepId }) =>
        `${deploymentId}-${stepId}@example.com`,
      substrateEnv: { DATA_DIR: "/tmp/wire" },
      dynamicSpawnEnv: () => ({}),
      subprocessSpawner: spawner,
    });

    expect(typeof wired.supervisor.spawn).toBe("function");
    expect(wired.getCredentialsSnapshot()).toBeNull();

    const result = await wired.supervisor.requestCancel({
      runId: "r-wire-1",
      origin: "supervisor-operator",
      reason: "wiring test",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(result.commitSha).toBe("stub-sha");
    expect(result.seq).toBe(0);
  });

  test("routeInbound forwards delivered messages to the supervisor's mail subscription", () => {
    const transport = createInMemoryTransport();
    // generateKeyPair is async; this test only exercises the
    // mail-routing path so we synthesize a 32-byte seed without
    // calling crypto.
    const fakeSeed = new Uint8Array(32);
    const repoStore = createMinimalStubRepoStore();
    const wired = createSidecarWorkflowSupervisor({
      transport,
      repoStore,
      signingKeySeed: fakeSeed,
      workflowRunRepoId: { kind: "workflow-run", id: "inbound" },
      workflowRunRef: "refs/heads/main",
      deploymentId: "inbound",
      stepCount: 1,
      deploymentMailAddress: "inbound@example.com",
      deriveStepAddress: ({ deploymentId, stepId }) =>
        `${deploymentId}-${stepId}@example.com`,
      substrateEnv: {},
      dynamicSpawnEnv: () => ({}),
      subprocessSpawner: () => {
        throw new Error("spawner not invoked in this test");
      },
    });
    // Without a subscriber, routeInbound is a no-op rather than a
    // throw -- the wiring's mail bus map is a per-address Set that
    // returns early when no handler is registered.
    expect(() =>
      wired.routeInbound(new TextEncoder().encode("hello")),
    ).not.toThrow();
  });
});

describe("resolveDefaultRecyclePolicy (WORKFLOW_CHILD_MAX_RSS_BYTES)", () => {
  const ENV_KEY = "WORKFLOW_CHILD_MAX_RSS_BYTES";
  const original = process.env[ENV_KEY];

  function restoreEnv(): void {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  }

  test("defaults to the 3 GiB bound when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(resolveDefaultRecyclePolicy()).toEqual({
      maxRssBytes: DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES,
    });
    expect(DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES).toBe(3 * 1024 * 1024 * 1024);
    restoreEnv();
  });

  test("honors a valid positive override", () => {
    process.env[ENV_KEY] = "104857600";
    expect(resolveDefaultRecyclePolicy()).toEqual({ maxRssBytes: 104_857_600 });
    restoreEnv();
  });

  test('disables the bound when the env var is empty or "0"', () => {
    process.env[ENV_KEY] = "0";
    expect(resolveDefaultRecyclePolicy()).toEqual({});

    process.env[ENV_KEY] = "   ";
    expect(resolveDefaultRecyclePolicy()).toEqual({});
    restoreEnv();
  });

  test("falls back to the default for a non-numeric or non-positive override", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(resolveDefaultRecyclePolicy()).toEqual({
      maxRssBytes: DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES,
    });

    process.env[ENV_KEY] = "-5";
    expect(resolveDefaultRecyclePolicy()).toEqual({
      maxRssBytes: DEFAULT_WORKFLOW_CHILD_MAX_RSS_BYTES,
    });
    restoreEnv();
  });
});

describe("createPidTrackingRssReader", () => {
  function fakeHandle(pid: number): SubprocessHandle {
    return {
      pid,
      controlWriter: { write: () => undefined, close: () => undefined },
      controlReader: (async function* () {})(),
      eventReader: (async function* () {})(),
      kill: () => undefined,
      exited: new Promise<number>(() => undefined),
    } as unknown as SubprocessHandle;
  }

  test("readRssBytes reports undefined before the base spawner has run", () => {
    const { readRssBytes } = createPidTrackingRssReader(
      () => fakeHandle(111),
      () => 999,
    );
    expect(readRssBytes()).toBeUndefined();
  });

  test("readRssBytes tracks the pid across spawn calls, including a recycle respawn", () => {
    let nextPid = 111;
    const rssByPid = new Map<number, number>([
      [111, 1_000],
      [222, 2_000],
    ]);
    const seenPids: number[] = [];
    const { spawner, readRssBytes } = createPidTrackingRssReader(
      () => fakeHandle(nextPid),
      (pid) => {
        seenPids.push(pid);
        return rssByPid.get(pid);
      },
    );

    spawner({ binaryPath: "/bin/workflow-child", env: {} });
    expect(readRssBytes()).toBe(1_000);

    // A recycle respawn calls the same subprocessSpawner with a fresh
    // pid; readRssBytes must follow it rather than staying pinned to
    // the first child it ever saw.
    nextPid = 222;
    spawner({ binaryPath: "/bin/workflow-child", env: {} });
    expect(readRssBytes()).toBe(2_000);

    expect(seenPids).toEqual([111, 222]);
  });
});

describe("recyclePolicyWantsRssTracking", () => {
  test("is true only when maxRssBytes is set", () => {
    expect(recyclePolicyWantsRssTracking({ maxRssBytes: 1 })).toBe(true);
    expect(recyclePolicyWantsRssTracking({})).toBe(false);
    expect(
      recyclePolicyWantsRssTracking({ maxUptimeMs: 1000, maxGrantsAgeMs: 2 }),
    ).toBe(false);
  });
});

describe("createSidecarWorkflowSupervisor RSS-tracking spawner gate", () => {
  function pidReadingSpawner(): {
    spawner: SubprocessSpawner;
    pidWasRead: () => boolean;
  } {
    let pidWasRead = false;
    const spawner: SubprocessSpawner = () => {
      const controlChild = createMemoryNdjsonStream();
      const eventChild = createMemoryFrameStream();
      const handle: Partial<SubprocessHandle> = {
        controlWriter: controlChild.writer,
        controlReader: controlChild.reader,
        eventReader: eventChild.reader,
        kill: () => undefined,
        exited: new Promise<number>(() => undefined),
      };
      Object.defineProperty(handle, "pid", {
        get() {
          pidWasRead = true;
          return 4242;
        },
      });
      return handle as SubprocessHandle;
    };
    return { spawner, pidWasRead: () => pidWasRead };
  }

  async function spawnAndSettle(
    wired: ReturnType<typeof createSidecarWorkflowSupervisor>,
  ): Promise<void> {
    // The ready handshake never completes against this bare spawner, so the
    // supervisor's spawn() call never resolves; only its synchronous
    // pre-handshake work (calling subprocessSpawner and reading handle.pid
    // off the result) is under test. Fire-and-forget with a swallowed
    // rejection, then yield a few ticks for that synchronous work to run.
    wired.supervisor
      .spawn({ stepOrder: ["step-1"], definitionHash: "hash-1" })
      .catch(() => undefined);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  test("reads the child pid (tracking installed) when maxRssBytes is set", async () => {
    const { spawner, pidWasRead } = pidReadingSpawner();
    const wired = createSidecarWorkflowSupervisor({
      transport: createInMemoryTransport(),
      repoStore: createMinimalStubRepoStore(),
      signingKeySeed: new Uint8Array(32),
      workflowRunRepoId: { kind: "workflow-run", id: "rss-on" },
      workflowRunRef: "refs/heads/main",
      deploymentId: "rss-on",
      stepCount: 1,
      deploymentMailAddress: "rss-on@example.com",
      deriveStepAddress: ({ deploymentId, stepId }) =>
        `${deploymentId}-${stepId}@example.com`,
      substrateEnv: {},
      dynamicSpawnEnv: () => ({}),
      subprocessSpawner: spawner,
      recyclePolicy: { maxRssBytes: 1024 },
    });

    await spawnAndSettle(wired);
    expect(pidWasRead()).toBe(true);
  });

  test("never reads the child pid (tracking skipped) when the recycle policy has no maxRssBytes", async () => {
    const { spawner, pidWasRead } = pidReadingSpawner();
    const wired = createSidecarWorkflowSupervisor({
      transport: createInMemoryTransport(),
      repoStore: createMinimalStubRepoStore(),
      signingKeySeed: new Uint8Array(32),
      workflowRunRepoId: { kind: "workflow-run", id: "rss-off" },
      workflowRunRef: "refs/heads/main",
      deploymentId: "rss-off",
      stepCount: 1,
      deploymentMailAddress: "rss-off@example.com",
      deriveStepAddress: ({ deploymentId, stepId }) =>
        `${deploymentId}-${stepId}@example.com`,
      substrateEnv: {},
      dynamicSpawnEnv: () => ({}),
      subprocessSpawner: spawner,
      recyclePolicy: {},
    });

    await spawnAndSettle(wired);
    expect(pidWasRead()).toBe(false);
  });

  test("still forwards a non-empty recycle policy without maxRssBytes, just without pid tracking", async () => {
    const { spawner, pidWasRead } = pidReadingSpawner();
    const wired = createSidecarWorkflowSupervisor({
      transport: createInMemoryTransport(),
      repoStore: createMinimalStubRepoStore(),
      signingKeySeed: new Uint8Array(32),
      workflowRunRepoId: { kind: "workflow-run", id: "rss-uptime-only" },
      workflowRunRef: "refs/heads/main",
      deploymentId: "rss-uptime-only",
      stepCount: 1,
      deploymentMailAddress: "rss-uptime-only@example.com",
      deriveStepAddress: ({ deploymentId, stepId }) =>
        `${deploymentId}-${stepId}@example.com`,
      substrateEnv: {},
      dynamicSpawnEnv: () => ({}),
      subprocessSpawner: spawner,
      recyclePolicy: { maxUptimeMs: 60_000 },
    });

    await spawnAndSettle(wired);
    expect(pidWasRead()).toBe(false);
  });
});

describe("createSidecarDeployRouter provision-step (no-spawn) mode", () => {
  test("a provisionStep frame inits the repo and records the hub key without spawning", async () => {
    const transport = createInMemoryTransport();
    const keyPair = await generateKeyPair();

    const initRepoCalls: string[] = [];
    const recordHubKeyCalls: { address: string; hubKey: string }[] = [];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provisionStep touches no RepoStore method; the Proxy throws if it ever does
    const repoStore = new Proxy({} as RepoStore, {
      get(_target, prop) {
        return () => {
          throw new Error(`stub RepoStore: ${String(prop)} not implemented`);
        };
      },
    });

    const router = createSidecarDeployRouter({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provisionStep exercises only initRepo
      sessions: {
        initRepo: async (a: string) => {
          initRepoCalls.push(a);
        },
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["sessions"],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provisionStep exercises only recordHubKey
      keyStore: {
        recordHubKey: (a: string, h: string) => {
          recordHubKeyCalls.push({ address: a, hubKey: h });
        },
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["keyStore"],
      transport,
      repoStore,
      signingKeySeed: keyPair.privateKey,
      createAgentCrypto: createEd25519Crypto,
      assertSourceBuildable: () => undefined,
      registerDeployment: () => undefined,
      unregisterDeployment: () => undefined,
    });

    const STEP_ADDR = "ins_dep_abc-step1@example.com";
    const HUB_KEY = "aa".repeat(32);
    const result = await router.deploy({
      type: "agent.deploy",
      agentAddress: STEP_ADDR,
      agentId: "ins_dep_abc-step1",
      hubPublicKey: HUB_KEY,
      provisionStep: true,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- provisionStep never inspects config
      config: {} as unknown as Parameters<
        ReturnType<typeof createSidecarDeployRouter>["deploy"]
      >[0]["config"],
    });

    // The step's agent-state repo is initialized and the hub key recorded,
    // so the follow-up full-closure deploy pack applies into a repo and
    // verifies against the recorded key.
    expect(initRepoCalls).toEqual([STEP_ADDR]);
    expect(recordHubKeyCalls).toEqual([
      { address: STEP_ADDR, hubKey: HUB_KEY },
    ]);

    // The ack carries the sidecar principal key (the hub discards it for a
    // workflow-derived per-step address).
    expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);

    // Nothing spawned: no supervisor, so no active address.
    expect(router.activeAddresses()).toEqual([]);
  });
});

// --------------------------------------------------------------------
// Multi-step branch tests
// --------------------------------------------------------------------

function createMemoryNdjsonStream() {
  const buffer: string[] = [];
  let waiter: (() => void) | null = null;
  let done = false;
  function wake() {
    const w = waiter;
    waiter = null;
    if (w) w();
  }
  const reader: NdjsonReader = {
    read(): AsyncIterableIterator<string> {
      return (async function* () {
        while (true) {
          if (buffer.length > 0) {
            const next = buffer.shift();
            if (next === undefined) {
              throw new Error("buffer shift returned undefined");
            }
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      })();
    },
  };
  const writer: NdjsonWriter = {
    write(line: string) {
      buffer.push(line.replace(/\n$/, ""));
      wake();
      return Promise.resolve();
    },
  };
  return {
    writer,
    reader,
    inject(line: string) {
      buffer.push(line.replace(/\n$/, ""));
      wake();
    },
    flushed(): readonly string[] {
      return buffer.slice();
    },
    close() {
      done = true;
      wake();
    },
  };
}

function createMemoryFrameStream() {
  const buffer: Uint8Array[] = [];
  let waiter: (() => void) | null = null;
  let done = false;
  function wake() {
    const w = waiter;
    waiter = null;
    if (w) w();
  }
  const reader: FrameReader = {
    read(): AsyncIterableIterator<Uint8Array> {
      return (async function* () {
        while (true) {
          if (buffer.length > 0) {
            const next = buffer.shift();
            if (next === undefined) {
              throw new Error("frame buffer shift returned undefined");
            }
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      })();
    },
  };
  return {
    reader,
    inject(bytes: Uint8Array) {
      buffer.push(bytes);
      wake();
    },
    close() {
      done = true;
      wake();
    },
  };
}

function createTempBaseDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Build a stub RepoStore whose `getRepoDir` resolves under the supplied
 * tempBase. The multi-step branch's `assembleCredentialsSnapshot`
 * reads `state/grants.json` from disk -- missing files are treated as
 * empty grants, so a freshly-created tempBase produces an empty
 * credentials snapshot which is what the wiring test wants.
 */
function createSpawnTestRepoStore(tempBase: string): RepoStore {
  const stub: Partial<RepoStore> = {
    getRepoDir(repoId: RepoId): string {
      return path.join(tempBase, repoId.kind, repoId.id);
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      await args.merge(new Map());
      return { commitSha: "stub-sha", newlyTerminalRuns: [] };
    },
    // The deploy router's grants bridge writes `state/grants.json` to
    // each step's agent-state repo before `spawn()`. Mirror the
    // `getRepoDir` layout so the write lands where the subsequent
    // `assembleCredentialsSnapshot` working-tree read looks for it.
    async writeTree(_p, repoId, _ref, content) {
      const dir = path.join(tempBase, repoId.kind, repoId.id);
      for (const [relPath, contents] of Object.entries(content.files)) {
        const full = path.join(dir, relPath);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, contents);
      }
      return { commitSha: "stub-sha", newlyTerminalRuns: [] };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; only getRepoDir + writeTreePreservingPrefix + writeTree exercised
  return new Proxy(stub as RepoStore, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value !== undefined) return value;
      return () => {
        throw new Error(
          `stub RepoStore: ${String(prop)} not implemented for this test`,
        );
      };
    },
  });
}

type WorkflowProjection = NonNullable<AgentDeployFrame["workflow"]>;
// A single source: each step's `sources` value is an ordered failover chain,
// so the fixture element type is the chain's member.
type InferenceSourceFixture = WorkflowProjection["sources"][string][number];

type MultistepDeployArgs = {
  sources: WorkflowProjection["sources"];
  definition: {
    id: string;
    triggers: unknown[];
    stepOrder: string[];
    steps: Record<string, unknown>;
  };
  /**
   * Override the deploy frame's `agentAddress`. Single-step projections
   * are the agent-launch identity path: the deploy router derives the
   * sole step's agent-state repo from `parseAgentId(agentAddress)`, which
   * requires the canonical `ins_<id>@<domain>` shape. Tests that drive a
   * single-step projection supply a valid instance address here; the
   * default keeps the historical multi-step address for the multi-step
   * tests (whose derived per-step repos do not parse the frame address).
   */
  agentAddress?: string;
  /**
   * Override the deploy frame's `agentId`. A production single-AGENT launch
   * carries the REAL agent def id (`agt_<defId>`), which the router must NOT
   * try to strip a deploymentId from; it recovers the raw id off the address
   * instead. The default keeps the multi-step `ins_<deploymentId>` shape.
   */
  agentId?: string;
};

function makeInferenceSource(id: string): InferenceSourceFixture {
  return {
    id,
    provider: "anthropic",
    baseURL: "https://api.anthropic.com",
    apiKey: `sk-${id}`,
    model: "claude-3-5",
  };
}

function makeMultistepFrame(args: MultistepDeployArgs): AgentDeployFrame {
  return {
    type: "agent.deploy",
    // Production multi-step deployments carry the deployment-level address
    // `ins_<deploymentId>@<domain>`, whose instance id equals the frame's
    // `agentId`; the router's CL-2199 raw-deploymentId recovery reads the
    // instance id off THIS address (`parseAgentId`), so the fixture must be
    // the canonical `ins_<id>@<domain>` shape.
    agentAddress: args.agentAddress ?? "ins_multi-agent@example.com",
    // Orchestrator mints agentId as `ins_<deploymentId>`, matching the
    // instance id of the address above.
    agentId: args.agentId ?? "ins_multi-agent",
    hubPublicKey: "hub-pk",
    // The wire-side HarnessConfig has many required fields. On the workflow
    // deploy path the router reads `config.sessionId`, `config.grants`,
    // (CL-2199) `config.tenantId`, and `config.principalId` (the single-agent
    // instance principal threaded to the child); the first two tolerate the
    // empty placeholder, and tenantId + principalId are supplied so the
    // substrate-env completeness assertion passes.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the workflow path reads only config.sessionId/config.grants/config.tenantId/config.principalId
    config: {
      tenantId: "ten_test",
      principalId: "prn_test",
    } as AgentDeployFrame["config"],
    workflow: {
      definition: args.definition,
      sources: args.sources,
    },
  };
}

function defaultMultistepSources(): WorkflowProjection["sources"] {
  return {
    "step-1": [makeInferenceSource("step-1")],
    "step-2": [makeInferenceSource("step-2")],
  };
}

describe("validateWorkflowProjection", () => {
  test("rejects an empty stepOrder", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: { id: "w-1", stepOrder: [], steps: {} },
        sources: {},
      }),
    ).toThrow(/stepOrder must be a non-empty array/);
  });

  test("rejects a stepId that violates STEP_ID_PATTERN", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: {
          id: "w-1",
          stepOrder: ["bad.step"],
          steps: { "bad.step": {} },
        },
        sources: { "bad.step": {} },
      }),
    ).toThrow(/must match \^/);
  });

  test("rejects a missing sources entry for a stepOrder id", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: {
          id: "w-1",
          stepOrder: ["step-1"],
          steps: { "step-1": {} },
        },
        sources: {},
      }),
    ).toThrow(/sources is missing entry/);
  });

  test("rejects an empty sources chain for a stepOrder id", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: {
          id: "w-1",
          stepOrder: ["step-1"],
          steps: { "step-1": {} },
        },
        sources: { "step-1": [] },
      }),
    ).toThrow(/must be a non-empty array/);
  });

  test("rejects a non-array sources entry for a stepOrder id", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: {
          id: "w-1",
          stepOrder: ["step-1"],
          steps: { "step-1": {} },
        },
        sources: { "step-1": {} },
      }),
    ).toThrow(/must be a non-empty array/);
  });

  test("accepts a well-formed projection", () => {
    expect(() =>
      validateWorkflowProjection({
        definition: {
          id: "w-1",
          stepOrder: ["step-1", "step-2"],
          steps: { "step-1": {}, "step-2": {} },
        },
        sources: { "step-1": [{}], "step-2": [{}] },
      }),
    ).not.toThrow();
  });
});

describe("computeWireDefinitionHash", () => {
  test("is stable across key-ordering differences", async () => {
    const a = { id: "w-1", stepOrder: ["s1"], steps: { s1: { kind: "step" } } };
    const b = { steps: { s1: { kind: "step" } }, stepOrder: ["s1"], id: "w-1" };
    expect(await computeWireDefinitionHash(a)).toBe(
      await computeWireDefinitionHash(b),
    );
  });

  test("differs across different definitions", async () => {
    const a = { id: "w-1", stepOrder: ["s1"], steps: { s1: {} } };
    const b = { id: "w-2", stepOrder: ["s1"], steps: { s1: {} } };
    expect(await computeWireDefinitionHash(a)).not.toBe(
      await computeWireDefinitionHash(b),
    );
  });
});

describe("createSidecarDeployRouter multi-step branch", () => {
  async function buildMultistepFixture(opts: {
    spawner: SubprocessSpawner;
    publishWorkflowInferenceEvent?: (
      address: string,
      event: EventPayload,
      sessionId: string | undefined,
    ) => void;
    multistepBinaryPath?: string;
    multistepSubstrateEnv?: Record<string, string>;
    multistepMailRouter?: MultistepMailRouter;
    multistepSourcesRouter?: MultistepSourcesRouter;
    registerDeployment?: (args: {
      deploymentId: string;
      agentAddress: string;
    }) => void;
    assertSourceBuildable?: Parameters<
      typeof createSidecarDeployRouter
    >[0]["assertSourceBuildable"];
    /**
     * Reuse an existing transport instead of a fresh one. The restore
     * tests deploy through one fixture, then build a SECOND fixture over
     * the same on-disk data dir with a FRESH transport to model a sidecar
     * process restart (the in-memory transport is process-local, so a
     * restart starts with an empty registration table).
     */
    transport?: ReturnType<typeof createInMemoryTransport>;
    /**
     * Spawn ready-handshake timeout (ms) threaded to every supervisor the
     * router constructs. The ready-timeout test uses a small value with a
     * spawner that never drives `ready`, asserting the deploy rejects with
     * the threaded value echoed in the message.
     */
    readyTimeoutMs?: number;
    /**
     * Fixed keypair the keyStore's `loadOrGenerateKey` returns for the head.
     * The B-key test pins the single-step deploy ack to this agent key; when
     * omitted a fresh keypair is minted per call as before.
     */
    headKeyPair?: Awaited<ReturnType<typeof generateKeyPair>>;
  }) {
    const transport = opts.transport ?? createInMemoryTransport();
    const keyPair = await generateKeyPair();
    const tempBase = await createTempBaseDir("sidecar-multistep-");
    const repoStore = createSpawnTestRepoStore(tempBase);
    // The deploy router's multi-step branch materializes
    // `workflow.json` under `${SIDECAR_DATA_DIR}/assets/workflow/<id>/`
    // before invoking the spawner. The test fixture defaults the data
    // dir to a per-test mkdtemp so the wiring tests do not have to
    // touch a real /tmp path; callers can override
    // `SIDECAR_DATA_DIR` (and any other key) by passing
    // `multistepSubstrateEnv`.
    // Mirror the real boot-edge substrate env (see index.ts) so the router's
    // CL-2363 completeness assertion over SIDECAR_SUBSTRATE_CONFIG_KEYS passes.
    // The per-deploy keys (WORKFLOW_*_REPO_ID/REF, STEP_INFERENCE_SOURCES,
    // TENANT_ID, WORKFLOW_RAW_DEPLOYMENT_ID) are added by the router itself.
    const defaultSubstrateEnv: Record<string, string> = {
      SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-multistep-data-"),
      SIDECAR_SIGNING_PUBLIC_KEY: "deadbeef",
      SIDECAR_SIGNING_PRIVATE_KEY: "cafef00d",
      HUB_WS_URL: "ws://hub.test/ws",
      SIDECAR_ID: "sc_test",
      SIDECAR_TOKEN: "tok_test",
      SIDECAR_CACHE_MAX_BYTES: "1000000",
      SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "1000000",
      SIDECAR_ADAPTER_MANIFEST: "[]",
    };
    const mergedSubstrateEnv: Record<string, string> = {
      ...defaultSubstrateEnv,
      ...(opts.multistepSubstrateEnv ?? {}),
    };
    const router = createSidecarDeployRouter({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the workflow path never invokes provisionAgent/persistHubPublicKey (single-step uses the narrow initRepo; the child mints its own key); the stubs throw if it does. initRepo is a no-op for the single-step head repo.
      sessions: {
        provisionAgent: async () => {
          throw new Error("workflow branch must not invoke provisionAgent");
        },
        persistHubPublicKey: async () => {
          throw new Error(
            "workflow branch must not invoke persistHubPublicKey",
          );
        },
        initRepo: async () => undefined,
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["sessions"],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test stub; the single-step head deploy records the hub key for pack verification
      keyStore: {
        recordHubKey: () => undefined,
        loadOrGenerateKey: async () => ({
          keyPair: opts.headKeyPair ?? (await generateKeyPair()),
          isNew: false,
        }),
        // A single-step spawn failure unwinds the recorded hub key via
        // forgetAgent; the fixture exercises that unwind, so the stub must
        // honor the call.
        forgetAgent: () => undefined,
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["keyStore"],
      transport,
      repoStore,
      signingKeySeed: keyPair.privateKey,
      createAgentCrypto: createEd25519Crypto,
      assertSourceBuildable: opts.assertSourceBuildable ?? (() => undefined),
      registerDeployment: opts.registerDeployment ?? (() => undefined),
      unregisterDeployment: () => {
        /* no-op */
      },
      multistepSubprocessSpawner: opts.spawner,
      ...(opts.multistepBinaryPath !== undefined
        ? { multistepBinaryPath: opts.multistepBinaryPath }
        : {}),
      multistepSubstrateEnv: mergedSubstrateEnv,
      ...(opts.publishWorkflowInferenceEvent !== undefined
        ? {
            publishWorkflowInferenceEvent: opts.publishWorkflowInferenceEvent,
          }
        : {}),
      ...(opts.multistepMailRouter !== undefined
        ? { multistepMailRouter: opts.multistepMailRouter }
        : {}),
      ...(opts.multistepSourcesRouter !== undefined
        ? { multistepSourcesRouter: opts.multistepSourcesRouter }
        : {}),
      ...(opts.readyTimeoutMs !== undefined
        ? { readyTimeoutMs: opts.readyTimeoutMs }
        : {}),
    });
    return {
      router,
      tempBase,
      keyPair,
      substrateEnv: mergedSubstrateEnv,
      transport,
    };
  }

  test("validates the projection, constructs SpawnOpts from the frame, drives spawn, and acks the deployment address's public key", async () => {
    const supervisorIpcKeyPair = await generateKeyPair();
    const childIpcKeyPair = await generateKeyPair();
    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventChildToSupervisor = createMemoryFrameStream();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let observedBinary: string | undefined;
    let observedEnv: Record<string, string> | undefined;
    const spawner: SubprocessSpawner = ({ binaryPath, env }) => {
      observedBinary = binaryPath;
      observedEnv = env;
      const handle: SubprocessHandle = {
        pid: 7321,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };

    const multiDataDir = await createTempBaseDir("sidecar-multi-data-");
    // The deployment address's own key -- what `loadOrGenerateKey` mints and
    // `signChallenge` signs reconnect challenges with. Pin it so the ack
    // assertion below is deterministic.
    const deploymentKeyPair = await generateKeyPair();
    const { router } = await buildMultistepFixture({
      spawner,
      headKeyPair: deploymentKeyPair,
      multistepBinaryPath: "/fake/bin/multistep-workflow-child",
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: multiDataDir,
      },
    });

    // Hijack the supervisor's ipc keypair factory by routing through
    // the test-construction surface: the router constructs the
    // supervisor via createSidecarWorkflowSupervisor which does not
    // expose ipcKeyPairFactory. The supervisor's default keypair is
    // generated with generateKeyPair; the test signs the `ready` frame
    // with whatever channelId the spawn-time env carries plus the
    // child's keypair, and the supervisor accepts a bootstrap
    // signature from any childPublicKey carried in the `ready` payload.

    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-router-test",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });

    const deployPromise = router.deploy(frame);

    // Wait until the spawner has been invoked.
    while (observedEnv === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }

    const env = observedEnv;
    expect(observedBinary).toBe("/fake/bin/multistep-workflow-child");
    expect(env).toMatchObject({
      SIDECAR_DATA_DIR: multiDataDir,
      DEPLOYMENT_ID: "ins_multi-agent-example-com",
      MAILBOX_ADDRESS: "ins_multi-agent@example.com",
    });
    // CL-2199 raw-deploymentId recovery: for a multi-step deploy the address's
    // instance id (`ins_multi-agent`) equals the frame's `agentId`, so the
    // recovered raw id is byte-identical to the prior
    // `deriveRawDeploymentId(frame.agentId)` value.
    expect(env[RAW_DEPLOYMENT_ID_ENV_KEY]).toBe("multi-agent");
    expect(env.DEFINITION_HASH).toBe(
      await computeWireDefinitionHash(definition),
    );
    expect(env[STEP_INFERENCE_SOURCES_ENV_KEY]).toBe(JSON.stringify(sources));
    expect(env.IPC_CHANNEL_ID).toMatch(/^[0-9a-f]{32}$/);

    // Drive the `ready` handshake.
    const channelId = env.IPC_CHANNEL_ID;
    if (channelId === undefined) {
      throw new Error("IPC_CHANNEL_ID not set in spawn-time env");
    }
    const childSender = createControlChannelSender({
      privateKeySeed: childIpcKeyPair.privateKey,
      channelId,
      writer: {
        write(line: string) {
          childToSupervisor.inject(line);
          return Promise.resolve();
        },
      },
    });
    await childSender.send({
      type: "ready",
      data: {
        childPid: 7321,
        childPublicKey: hexEncode(childIpcKeyPair.publicKey),
      },
    });

    const result = await deployPromise;
    // Every deployment -- single- or multi-step -- acks the deployment
    // address's own public key, the one `signChallenge` signs reconnect
    // challenges with, so the hub can verify ownership on reconnect. A
    // multi-step deployment previously acked the supervisor principal key,
    // which the hub discarded. The hex is a 64-character lowercase string.
    expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.publicKey).toBe(hexEncode(deploymentKeyPair.publicKey));

    // Teardown: kill the child so the spawn-time pumps unwind.
    // Use unused supervisorToChild to silence the linter.
    void supervisorToChild;
    void supervisorIpcKeyPair;
  });

  test("a second same-address deploy is rejected mid-spawn without touching the live deployment", async () => {
    // Pins the synchronous single-flight reservation guard. The first
    // deploy suspends inside supervisor.spawn awaiting the child's `ready`
    // handshake -- the window in which its reservation is held but
    // `activeSupervisors` is not yet populated. A second same-address frame
    // arriving in that window must be rejected at the reservation guard (its
    // own message, distinct from the spawn-core backstop) before it touches
    // any state belonging to the live deploy.
    const childIpcKeyPair = await generateKeyPair();
    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventChildToSupervisor = createMemoryFrameStream();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let spawnCount = 0;
    let observedEnv: Record<string, string> | undefined;
    const spawner: SubprocessSpawner = ({ env }) => {
      spawnCount += 1;
      observedEnv = env;
      const handle: SubprocessHandle = {
        pid: 4242,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };

    const multiDataDir = await createTempBaseDir("sidecar-concurrent-deploy-");
    const registered: string[] = [];
    const { router } = await buildMultistepFixture({
      spawner,
      multistepSubstrateEnv: { SIDECAR_DATA_DIR: multiDataDir },
      registerDeployment: ({ agentAddress }) => {
        registered.push(agentAddress);
      },
    });

    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-concurrent",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });

    const firstDeploy = router.deploy(frame);
    // Wait until the first deploy has spawned and is now suspended in the
    // ready handshake with the reservation held.
    while (observedEnv === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }

    // The loser is rejected at the reservation guard, not the spawn-core
    // backstop -- the guard's message is the one asserted here.
    await expect(router.deploy(frame)).rejects.toThrow(
      /is already deployed; undeploy it before redeploying/,
    );
    // It never reached the spawner.
    expect(spawnCount).toBe(1);

    // Drive the first deploy's ready handshake so it completes, then confirm
    // the winner is the live, registered deployment.
    const channelId = observedEnv.IPC_CHANNEL_ID;
    if (channelId === undefined) {
      throw new Error("IPC_CHANNEL_ID not set in spawn-time env");
    }
    const childSender = createControlChannelSender({
      privateKeySeed: childIpcKeyPair.privateKey,
      channelId,
      writer: {
        write(line: string) {
          childToSupervisor.inject(line);
          return Promise.resolve();
        },
      },
    });
    await childSender.send({
      type: "ready",
      data: {
        childPid: 4242,
        childPublicKey: Buffer.from(childIpcKeyPair.publicKey).toString("hex"),
      },
    });

    const result = await firstDeploy;
    expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(registered).toEqual([frame.agentAddress]);
    expect(router.activeAddresses()).toEqual([frame.agentAddress]);

    void supervisorToChild;
  });

  test("registers a multistepMailRouter handler against the deployment address once spawn succeeds", async () => {
    // Drives the spawn handshake the same way the first multi-step
    // test does, but injects a `multistepMailRouter` and asserts the
    // deploy router registered a handler against the deployment's
    // mail address by the time `deploy(frame)` resolves. The handler
    // is what the sidecar hub-link's `mail.inbound` path dispatches
    // through; without this registration, an inbound mail aimed at
    // the deployment address falls into the legacy session path,
    // which has no transport entry and no `sessions` row for the
    // deployment address.
    const childIpcKeyPair = await generateKeyPair();
    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventChildToSupervisor = createMemoryFrameStream();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let observedEnv: Record<string, string> | undefined;
    const spawner: SubprocessSpawner = ({ env }) => {
      observedEnv = env;
      const handle: SubprocessHandle = {
        pid: 9123,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };

    const mailRouter = createMultistepMailRouter();
    const { router } = await buildMultistepFixture({
      spawner,
      multistepMailRouter: mailRouter,
    });

    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-mail-router-test",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });

    const deployPromise = router.deploy(frame);

    while (observedEnv === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }

    const channelId = observedEnv.IPC_CHANNEL_ID;
    if (channelId === undefined) {
      throw new Error("IPC_CHANNEL_ID not set in spawn-time env");
    }
    const childSender = createControlChannelSender({
      privateKeySeed: childIpcKeyPair.privateKey,
      channelId,
      writer: {
        write(line: string) {
          childToSupervisor.inject(line);
          return Promise.resolve();
        },
      },
    });
    await childSender.send({
      type: "ready",
      data: {
        childPid: 9123,
        childPublicKey: hexEncode(childIpcKeyPair.publicKey),
      },
    });

    await deployPromise;

    // The handler must be installed against the deployment's mail
    // address (`frame.agentAddress`), and tryRoute must claim it.
    const claimed = mailRouter.tryRoute(
      frame.agentAddress,
      new Uint8Array([1, 2, 3]),
    );
    expect(claimed).toBe(true);

    // Teardown.
    void supervisorToChild;
  });

  test("does not register a multistepMailRouter handler if spawn rejects", async () => {
    const mailRouter = createMultistepMailRouter();
    const crashSpawner: SubprocessSpawner = () => {
      throw new Error("ENOENT: binary missing");
    };
    const { router } = await buildMultistepFixture({
      spawner: crashSpawner,
      multistepMailRouter: mailRouter,
    });

    const frame = makeMultistepFrame({
      agentAddress: "ins_crash-noreg@example.com",
      definition: {
        id: "wf-crash-noreg",
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1"],
        steps: { "step-1": { kind: "step" } },
      },
      sources: { "step-1": [makeInferenceSource("step-1")] },
    });

    await expect(router.deploy(frame)).rejects.toThrow(
      /ENOENT: binary missing/,
    );

    expect(mailRouter.tryRoute(frame.agentAddress, new Uint8Array([1]))).toBe(
      false,
    );
  });

  test("rejects a deploy whose step pins an unbuildable provider before spawning", async () => {
    // The source-admission gate runs before any state is claimed or the
    // child is spawned. A step whose pinned source names a provider the
    // sidecar cannot build must reject the whole deploy synchronously --
    // the admission control property -- rather than spawning a child that
    // fails when the step's inference first resolves.
    let spawnCount = 0;
    const trackingSpawner: SubprocessSpawner = () => {
      spawnCount++;
      throw new Error("spawn must not be reached for an inadmissible source");
    };
    const { router } = await buildMultistepFixture({
      spawner: trackingSpawner,
      assertSourceBuildable: (source) => {
        if (source.provider === "ghost-provider") {
          throw new Error(
            `Source provider "${source.provider}" is not registered`,
          );
        }
      },
    });

    const frame = makeMultistepFrame({
      agentAddress: "ins_unbuildable@example.com",
      definition: {
        id: "wf-unbuildable",
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1"],
        steps: { "step-1": { kind: "step" } },
      },
      sources: {
        "step-1": [
          {
            ...makeInferenceSource("step-1"),
            provider: "ghost-provider",
          },
        ],
      },
    });

    await expect(router.deploy(frame)).rejects.toThrow(
      /ghost-provider.*not registered/,
    );
    expect(spawnCount).toBe(0);
  });

  test("a spawner that throws synchronously surfaces a structured rejection rather than hanging in starting", async () => {
    // Simulates `Bun.spawn` failing to launch (binary missing,
    // permissions error). The router must surface the rejection
    // through `deploy(frame)` without leaving the supervisor wedged.
    const crashSpawner: SubprocessSpawner = () => {
      throw new Error("ENOENT: binary missing");
    };

    const { router } = await buildMultistepFixture({ spawner: crashSpawner });

    const frame = makeMultistepFrame({
      agentAddress: "ins_crash@example.com",
      definition: {
        id: "wf-crash",
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1"],
        steps: { "step-1": { kind: "step" } },
      },
      sources: {
        "step-1": [makeInferenceSource("step-1")],
      },
    });

    await expect(router.deploy(frame)).rejects.toThrow(
      /ENOENT: binary missing/,
    );
  });

  test("recovers the raw deploymentId off the address for a single-AGENT frame (agentId = agt_<x>) instead of throwing", async () => {
    // Regression: production single-agent launches (Myra/Oat/triage) deploy
    // through this router as a single-step workflow whose frame carries the
    // REAL agent def id (`agt_<defId>`), NOT an `ins_<deploymentId>` shape.
    // The prior recovery stripped `ins_` off `frame.agentId` and threw
    // "cannot recover raw deploymentId" for every such launch (a provision-
    // phase 503). Recovering off the address's instance id fixes it.
    let observedEnv: Record<string, string> | undefined;
    const capturingSpawner: SubprocessSpawner = ({ env }) => {
      observedEnv = env;
      // Fail the spawn with a benign error AFTER capturing the env: reaching
      // the spawner at all proves the router got past the raw-id recovery.
      throw new Error("ENOENT: benign spawn stop");
    };

    const { router } = await buildMultistepFixture({
      spawner: capturingSpawner,
    });

    const frame = makeMultistepFrame({
      agentId: "agt_myra_def",
      agentAddress: "ins_realinst123@example.com",
      definition: {
        id: "wf_agt_myra_def",
        triggers: [{ type: "manual" }],
        stepOrder: ["default"],
        steps: { default: { kind: "step" } },
      },
      sources: {
        default: [makeInferenceSource("default")],
      },
    });

    // Old code rejects with /cannot recover raw deploymentId/ BEFORE spawn;
    // new code reaches the spawner and rejects with the benign spawn error.
    await expect(router.deploy(frame)).rejects.toThrow(/benign spawn stop/);
    expect(observedEnv).toBeDefined();
    // Raw id is recovered off the address's instance id (`ins_realinst123`),
    // not the un-strippable `agt_myra_def` agentId.
    expect(observedEnv?.[RAW_DEPLOYMENT_ID_ENV_KEY]).toBe("realinst123");
    // CL-2199: the single-agent tool identity (the REAL agent def id + the
    // instance principal from the frame) is threaded to the child so the
    // resolver's single-agent branch keys the credential + hub-backed rails on
    // the identity the hub actually has, not the synthetic `ins_<raw>-default`.
    expect(observedEnv?.["WORKFLOW_SINGLE_AGENT_ID"]).toBe("agt_myra_def");
    expect(observedEnv?.["WORKFLOW_SINGLE_AGENT_PRINCIPAL_ID"]).toBe(
      "prn_test",
    );
  });

  test("rejects a malformed workflow projection at the router boundary before spawn fires", async () => {
    let spawnerInvoked = false;
    const spawner: SubprocessSpawner = () => {
      spawnerInvoked = true;
      throw new Error("spawner must not run for an invalid projection");
    };

    const { router } = await buildMultistepFixture({ spawner });

    const frame = makeMultistepFrame({
      definition: {
        id: "wf-bad",
        triggers: [{ type: "manual" }],
        // stepOrder mentions a step that has no steps[] entry
        stepOrder: ["step-1", "step-missing"],
        steps: { "step-1": { kind: "step" } },
      },
      sources: {
        "step-1": [makeInferenceSource("step-1")],
      },
    });

    await expect(router.deploy(frame)).rejects.toThrow(
      /workflow\.definition\.steps is missing entry/,
    );
    expect(spawnerInvoked).toBe(false);
  });

  test("does not drop the first upstream control frame the child sends after ready", async () => {
    // The supervisor's `pumpUpstreamControl` consumes the same
    // control-receive iterator `waitForReady` initialised. A buggy
    // `waitForReady` that finalised the iterator on `ready` would
    // silently drop the next upstream frame; a correct handoff
    // surfaces a `recycle.request` as a real supervisor.recycle()
    // call, which the supervisor implements by spawning a new child
    // via the injected subprocessSpawner. Counting spawner
    // invocations is the cleanest observable: 1 means the upstream
    // frame was dropped; >=2 means the pump consumed it.
    //
    // The mock spawner serves a fresh control/event pair per call so
    // the recycle path's own ready handshake completes; the test's
    // child sender signs `ready` once per spawn.
    type SpawnFixture = {
      supervisorToChild: ReturnType<typeof createMemoryNdjsonStream>;
      childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
      eventChildToSupervisor: ReturnType<typeof createMemoryFrameStream>;
      env: Record<string, string>;
      childIpcKeyPair: { privateKey: Uint8Array; publicKey: Uint8Array };
    };
    const spawns: SpawnFixture[] = [];
    let resolveSpawnAdded: (() => void) | null = null;
    const spawnAdded = (): Promise<void> =>
      new Promise((resolve) => {
        resolveSpawnAdded = resolve;
      });
    const spawner: SubprocessSpawner = ({ env }) => {
      const supervisorToChild = createMemoryNdjsonStream();
      const childToSupervisor = createMemoryNdjsonStream();
      const eventChildToSupervisor = createMemoryFrameStream();
      let resolveExit: ((code: number) => void) | undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const handle: SubprocessHandle = {
        pid: 4400 + spawns.length,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      // Capture the per-spawn streams synchronously so the test can
      // drive the child side once the supervisor has wired the
      // receiver.
      const fixture: SpawnFixture = {
        supervisorToChild,
        childToSupervisor,
        eventChildToSupervisor,
        env,
        // Mint a fresh child keypair per spawn; the supervisor's
        // receiveControlChannel opens in bootstrap mode and pins on
        // the per-spawn ready frame's `childPublicKey`.
        childIpcKeyPair: {
          publicKey: new Uint8Array(),
          privateKey: new Uint8Array(),
        },
      };
      spawns.push(fixture);
      const r = resolveSpawnAdded;
      resolveSpawnAdded = null;
      if (r) r();
      return handle;
    };

    const { router } = await buildMultistepFixture({ spawner });

    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-handoff",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });

    // Helper to drive the child side of one spawn fixture's ready
    // handshake, optionally chaining an upstream `recycle.request`.
    async function driveReady(
      fixture: SpawnFixture,
      opts: { sendRecycleRequest: boolean },
    ): Promise<void> {
      const channelId = fixture.env.IPC_CHANNEL_ID;
      if (channelId === undefined) {
        throw new Error("IPC_CHANNEL_ID not set in spawn-time env");
      }
      const childIpcKeyPair = await generateKeyPair();
      fixture.childIpcKeyPair = childIpcKeyPair;
      const childSender = createControlChannelSender({
        privateKeySeed: childIpcKeyPair.privateKey,
        channelId,
        writer: {
          write(line: string) {
            fixture.childToSupervisor.inject(line);
            return Promise.resolve();
          },
        },
      });
      await childSender.send({
        type: "ready",
        data: {
          childPid: 4400 + spawns.length,
          childPublicKey: hexEncode(childIpcKeyPair.publicKey),
        },
      });
      if (opts.sendRecycleRequest) {
        await childSender.send({
          type: "recycle.request",
          data: { reason: "iterator-handoff-test" },
        });
      }
    }

    const deployPromise = router.deploy(frame);

    // Wait for the first spawn to land.
    while (spawns.length === 0) {
      await spawnAdded();
    }
    const first = spawns[0];
    if (first === undefined) throw new Error("unreachable");
    // Drive ready + immediate recycle.request on the first spawn.
    await driveReady(first, { sendRecycleRequest: true });

    // The initial deploy's spawn() resolves once `ready` lands. The
    // supervisor's pump consumes the recycle.request and kicks off a
    // recycle, which calls the spawner a second time.
    await deployPromise;

    // Wait for the recycle's respawn.
    while (spawns.length < 2) {
      await spawnAdded();
    }
    const second = spawns[1];
    if (second === undefined) throw new Error("unreachable");
    // Drive ready on the second (recycle's) spawn so the recycle path
    // unwinds cleanly. We do not assert on this spawn's effects; the
    // assertion below covers the iterator-handoff invariant.
    await driveReady(second, { sendRecycleRequest: false });
    // Allow the recycle path to settle its post-ready work.
    await new Promise((r) => setTimeout(r, 25));

    expect(spawns.length).toBeGreaterThanOrEqual(2);
  });

  test("multistepSubstrateEnv carries HUB_WS_URL, SIDECAR_ID, SIDECAR_TOKEN through to the spawn-time env", async () => {
    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventChildToSupervisor = createMemoryFrameStream();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let observedEnv: Record<string, string> | undefined;
    const spawner: SubprocessSpawner = ({ env }) => {
      observedEnv = env;
      const handle: SubprocessHandle = {
        pid: 7600,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };
    const bootEdgeDataDir = await createTempBaseDir("sidecar-boot-edge-data-");
    const { router } = await buildMultistepFixture({
      spawner,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: bootEdgeDataDir,
        HUB_WS_URL: "ws://hub.example/sidecar-boot",
        SIDECAR_ID: "sidecar-boot-1",
        SIDECAR_TOKEN: "boot-token-abc",
      },
    });
    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-boot-edge",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });
    const deployPromise = router.deploy(frame);
    while (observedEnv === undefined) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(observedEnv.HUB_WS_URL).toBe("ws://hub.example/sidecar-boot");
    expect(observedEnv.SIDECAR_ID).toBe("sidecar-boot-1");
    expect(observedEnv.SIDECAR_TOKEN).toBe("boot-token-abc");
    expect(observedEnv.SIDECAR_DATA_DIR).toBe(bootEdgeDataDir);
    // Round out the spawn so the test exits cleanly.
    const channelId = observedEnv.IPC_CHANNEL_ID;
    if (channelId === undefined) {
      throw new Error("IPC_CHANNEL_ID missing from spawn env");
    }
    const childIpcKeyPair = await generateKeyPair();
    const childSender = createControlChannelSender({
      privateKeySeed: childIpcKeyPair.privateKey,
      channelId,
      writer: {
        write(line: string) {
          childToSupervisor.inject(line);
          return Promise.resolve();
        },
      },
    });
    await childSender.send({
      type: "ready",
      data: {
        childPid: 7600,
        childPublicKey: hexEncode(childIpcKeyPair.publicKey),
      },
    });
    await deployPromise;
  });

  test("a registerDeployment failure before spawn unwinds the slug and leaves the address claimable", async () => {
    // The multi-step partial-state unwind for the address-registry step.
    // `registerDeployment` runs BEFORE `supervisor.spawn` -- the replay the
    // spawn kicks off writes through the pack-pushing facade, which must
    // resolve the deployment-address mapping, so the mapping has to exist
    // before the spawn. A `registerDeployment` failure therefore throws
    // before any child is spawned; the unwind must release the slug (and
    // reverse nothing else, since nothing after it ran). The observable
    // evidence is that (a) NO child was spawned for the failed deploy and
    // (b) a subsequent deploy on the SAME address succeeds, which is only
    // possible if the slug was released.
    const childIpcKeyPair = await generateKeyPair();
    const spawnedHandles: {
      pid: number;
      killed: boolean;
      supervisorToChild: ReturnType<typeof createMemoryNdjsonStream>;
      childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
      eventChildToSupervisor: ReturnType<typeof createMemoryFrameStream>;
    }[] = [];
    const observedEnvs: Record<string, string>[] = [];
    const spawner: SubprocessSpawner = ({ env }) => {
      observedEnvs.push(env);
      const supervisorToChild = createMemoryNdjsonStream();
      const childToSupervisor = createMemoryNdjsonStream();
      const eventChildToSupervisor = createMemoryFrameStream();
      let resolveExit: ((code: number) => void) | undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const record = {
        pid: 9000 + spawnedHandles.length,
        killed: false,
        supervisorToChild,
        childToSupervisor,
        eventChildToSupervisor,
      };
      spawnedHandles.push(record);
      const handle: SubprocessHandle = {
        pid: record.pid,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          record.killed = true;
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };

    let registerCallCount = 0;
    const multiDataDir = await createTempBaseDir("sidecar-multi-unwind-");
    const { router } = await buildMultistepFixture({
      spawner,
      multistepBinaryPath: "/fake/bin/multistep-workflow-child",
      multistepSubstrateEnv: { SIDECAR_DATA_DIR: multiDataDir },
      registerDeployment: () => {
        registerCallCount += 1;
        if (registerCallCount === 1) {
          throw new Error("registerDeployment failure (synthetic)");
        }
      },
    });

    async function driveReadyFor(
      handleIndex: number,
      childPid: number,
    ): Promise<void> {
      while (spawnedHandles.length <= handleIndex) {
        await new Promise((r) => setTimeout(r, 1));
      }
      const env = observedEnvs[handleIndex];
      const channelId = env?.IPC_CHANNEL_ID;
      if (channelId === undefined) {
        throw new Error("IPC_CHANNEL_ID missing in observed env");
      }
      const record = spawnedHandles[handleIndex];
      if (record === undefined) {
        throw new Error(`spawnedHandles[${String(handleIndex)}] missing`);
      }
      const childSender = createControlChannelSender({
        privateKeySeed: childIpcKeyPair.privateKey,
        channelId,
        writer: {
          write(line: string) {
            record.childToSupervisor.inject(line);
            return Promise.resolve();
          },
        },
      });
      await childSender.send({
        type: "ready",
        data: {
          childPid,
          childPublicKey: hexEncode(childIpcKeyPair.publicKey),
        },
      });
    }

    const sources = defaultMultistepSources();
    const definition = {
      id: "wf-unwind-test",
      triggers: [{ type: "manual" }],
      stepOrder: ["step-1", "step-2"],
      steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
    };
    const frame = makeMultistepFrame({ definition, sources });

    // The first deploy throws at `registerDeployment`, which now runs before
    // `supervisor.spawn`, so it rejects WITHOUT spawning a child -- no ready
    // handshake to drive.
    let firstCaught: unknown;
    try {
      await router.deploy(frame);
    } catch (err) {
      firstCaught = err;
    }
    expect(firstCaught).toBeInstanceOf(Error);
    expect(firstCaught instanceof Error && firstCaught.message).toMatch(
      /registerDeployment failure \(synthetic\)/,
    );

    // No child was spawned for the failed deploy: the throw preceded spawn.
    expect(spawnedHandles).toHaveLength(0);

    // Re-deploy on the SAME address must succeed. If the unwind missed the
    // slug release, the second deploy would surface a phantom collision. The
    // router's public contract is that a failed deploy leaves the address
    // claimable again. This is the first deploy that actually spawns, so its
    // ready handshake is at index 0.
    const secondDeploy = router.deploy(frame);
    await driveReadyFor(0, 9000);
    const secondResult = await secondDeploy;
    expect(secondResult.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(registerCallCount).toBe(2);
  });

  // A mock spawner that serves a fresh control/event channel per spawn and
  // lets the test complete each child's `ready` handshake. `deploy` blocks
  // on `supervisor.spawn` until `ready` lands, so every spawned child needs
  // its handshake driven.
  function makeReadyDrivingSpawner(pidBase: number) {
    type Spawn = {
      env: Record<string, string>;
      childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
      eventChildToSupervisor: ReturnType<typeof createMemoryFrameStream>;
      // Captured so a test can inspect the raw control frames the
      // supervisor sends DOWN to the child (e.g. a `drain` frame) --
      // `supervisorToChild.writer` is the handle's `controlWriter`.
      supervisorToChild: ReturnType<typeof createMemoryNdjsonStream>;
      childSender?: ReturnType<typeof createControlChannelSender>;
      eventSender?: ReturnType<typeof createEventChannelSender>;
    };
    const spawns: Spawn[] = [];
    const spawner: SubprocessSpawner = ({ env }) => {
      const supervisorToChild = createMemoryNdjsonStream();
      const childToSupervisor = createMemoryNdjsonStream();
      const eventChildToSupervisor = createMemoryFrameStream();
      let resolveExit: ((code: number) => void) | undefined;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      spawns.push({
        env,
        childToSupervisor,
        eventChildToSupervisor,
        supervisorToChild,
      });
      const handle: SubprocessHandle = {
        pid: pidBase + spawns.length,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          childToSupervisor.close();
          eventChildToSupervisor.close();
          resolveExit?.(0);
        },
        exited,
      };
      return handle;
    };
    async function driveReadyFor(
      index: number,
      opts?: { sendRecycleRequest?: boolean },
    ): Promise<void> {
      while (spawns.length <= index) {
        await new Promise((r) => setTimeout(r, 1));
      }
      const spawn = spawns[index];
      if (spawn === undefined) {
        throw new Error(`spawn ${String(index)} missing`);
      }
      const channelId = spawn.env.IPC_CHANNEL_ID;
      if (channelId === undefined) {
        throw new Error("IPC_CHANNEL_ID missing in spawn env");
      }
      const childIpcKeyPair = await generateKeyPair();
      const childSender = createControlChannelSender({
        privateKeySeed: childIpcKeyPair.privateKey,
        channelId,
        writer: {
          write(line: string) {
            spawn.childToSupervisor.inject(line);
            return Promise.resolve();
          },
        },
      });
      // Retain the sender so a later recycle.request (recycleRequestFor)
      // signs with the SAME keypair the supervisor pinned from this ready.
      spawn.childSender = childSender;
      await childSender.send({
        type: "ready",
        data: {
          childPid: pidBase + index,
          childPublicKey: Buffer.from(childIpcKeyPair.publicKey).toString(
            "hex",
          ),
        },
      });
      if (opts?.sendRecycleRequest === true) {
        // Model the child asking to recycle; the supervisor's upstream pump
        // consumes it and respawns.
        await childSender.send({
          type: "recycle.request",
          data: { reason: "sources-rotation-recycle" },
        });
      }
    }
    return {
      spawner,
      driveReadyFor,
      spawnCount: () => spawns.length,
      envFor: (index: number): Record<string, string> | undefined =>
        spawns[index]?.env,
      async recycleRequestFor(index: number): Promise<void> {
        const sender = spawns[index]?.childSender;
        if (sender === undefined) {
          throw new Error(
            `spawn ${String(index)} has no sender; drive its ready first`,
          );
        }
        await sender.send({
          type: "recycle.request",
          data: { reason: "sources-rotation-recycle" },
        });
      },
      /**
       * Emit one InferenceEvent from the child's event channel, HMAC-signed
       * with the spawn's real `IPC_HMAC_KEY`/`IPC_CHANNEL_ID` -- the same
       * wire the production child uses -- so a test drives the router's
       * `onInferenceEvent` handler (and everything wired onto it) exactly
       * as the real event-channel receiver would.
       */
      async injectEvent(index: number, payload: EventPayload): Promise<void> {
        const spawn = spawns[index];
        if (spawn === undefined) {
          throw new Error(`spawn ${String(index)} missing`);
        }
        const hmacKeyHex = spawn.env.IPC_HMAC_KEY;
        const channelId = spawn.env.IPC_CHANNEL_ID;
        if (hmacKeyHex === undefined || channelId === undefined) {
          throw new Error("IPC_HMAC_KEY / IPC_CHANNEL_ID missing in spawn env");
        }
        const sender =
          spawn.eventSender ??
          createEventChannelSender({
            hmacKey: hexDecode(hmacKeyHex),
            channelId,
            writer: {
              write(bytes: Uint8Array) {
                spawn.eventChildToSupervisor.inject(bytes);
                return Promise.resolve();
              },
            },
          });
        spawn.eventSender = sender;
        await sender.send(payload);
      },
      /**
       * Raw NDJSON lines the supervisor wrote to the child's control
       * channel for this spawn (each an Ed25519-signed envelope whose
       * `envelope.payload.type` names the control frame, e.g. `"drain"`).
       * Used to assert the loop guard's `deadlineMs: 0` drain call actually
       * reached the child.
       */
      controlFramesTo(index: number): readonly string[] {
        return spawns[index]?.supervisorToChild.flushed() ?? [];
      },
    };
  }

  function isRegistered(
    transport: ReturnType<typeof createInMemoryTransport>,
    address: string,
  ): boolean {
    try {
      transport.getTransportFor(address);
      return true;
    } catch {
      return false;
    }
  }

  function singleStepFrame(
    agentAddress: string,
    definitionId: string,
  ): AgentDeployFrame {
    return makeMultistepFrame({
      agentAddress,
      definition: {
        id: definitionId,
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1"],
        steps: { "step-1": { kind: "step" } },
      },
      sources: { "step-1": [makeInferenceSource("step-1")] },
    });
  }

  test("a second deploy for a live address self-heals the resident supervisor (CL-3104)", async () => {
    const dataDir = await createTempBaseDir("sidecar-restore-dup-data-");
    const head = "ins_dup@example.com";

    const spawner = makeReadyDrivingSpawner(9700);
    const { router, transport } = await buildMultistepFixture({
      spawner: spawner.spawner,
      multistepSubstrateEnv: { SIDECAR_DATA_DIR: dataDir },
    });

    const deployPromise = router.deploy(singleStepFrame(head, "wf-dup"));
    await spawner.driveReadyFor(0);
    await deployPromise;

    // WORKBENCH-LOCAL (CL-3104): a second deploy for the already-live address
    // does NOT reject (upstream's behavior) -- a wake re-deploy that races a
    // failed hibernate ack finds the child still resident and must recover,
    // not wedge. The deploy branch tears the resident supervisor down
    // state-preservingly (reclaimDirs: false) and stands a fresh child up.
    const secondDeploy = router.deploy(singleStepFrame(head, "wf-dup"));
    await spawner.driveReadyFor(1);
    await secondDeploy;
    expect(spawner.spawnCount()).toBe(2);
    expect(isRegistered(transport, head)).toBe(true);
  });

  test("a deploy whose child never signals ready times out and rejects", async () => {
    const dataDir = await createTempBaseDir("sidecar-ready-timeout-data-");
    const head = "ins_readytimeout@example.com";

    // A spawner whose child is created but never driven through the `ready`
    // handshake. With a small threaded readyTimeoutMs the supervisor times
    // out, kills the child, and rejects the spawn. The message echoes the
    // threaded value, so this also proves readyTimeoutMs reaches the
    // supervisor across the router's forwarding.
    const spawner = makeReadyDrivingSpawner(10100);
    const { router } = await buildMultistepFixture({
      spawner: spawner.spawner,
      readyTimeoutMs: 40,
      multistepSubstrateEnv: { SIDECAR_DATA_DIR: dataDir },
    });

    await expect(
      router.deploy(singleStepFrame(head, "wf-readytimeout")),
    ).rejects.toThrow(/did not emit ready within 40ms/);
  });

  test("a single-step deploy acks the agent key, not the supervisor key", async () => {
    // The single-step head IS an agent identity: it signs its own reconnect
    // challenges with the agent key, and the hub records the ack's key into
    // agent_instance.publicKey and verifies the challenge against it. So the
    // ack must surface the AGENT key, not the supervisor principal key --
    // otherwise a rerouted instance's reconnect signature never matches.
    const headKeyPair = await generateKeyPair();
    const spawner = makeReadyDrivingSpawner(10300);
    const { router, keyPair: fixtureKeyPair } = await buildMultistepFixture({
      spawner: spawner.spawner,
      headKeyPair,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-bkey-data-"),
      },
    });

    const deployPromise = router.deploy(
      singleStepFrame("ins_bkey@example.com", "wf-bkey"),
    );
    await spawner.driveReadyFor(0);
    const result = await deployPromise;

    // The supervisor principal key is derived from the fixture's signing seed
    // (fixtureKeyPair); the head's agent key is the distinct headKeyPair.
    expect(result.publicKey).toBe(
      Buffer.from(headKeyPair.publicKey).toString("hex"),
    );
    expect(result.publicKey).not.toBe(
      Buffer.from(fixtureKeyPair.publicKey).toString("hex"),
    );
  });

  test("registers a sources-rotation handler for a single-step deployment", async () => {
    const sourcesRouter = createMultistepSourcesRouter();
    const spawner = makeReadyDrivingSpawner(10600);
    const { router } = await buildMultistepFixture({
      spawner: spawner.spawner,
      multistepSourcesRouter: sourcesRouter,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-sources-single-"),
      },
    });

    const deployPromise = router.deploy(
      singleStepFrame("ins_srcsingle@example.com", "wf-srcsingle"),
    );
    await spawner.driveReadyFor(0);
    await deployPromise;

    // The single-step deploy registered a rotation handler, so an inbound
    // sources.update for its address routes.
    expect(
      await sourcesRouter.tryRoute({
        type: "sources.update",
        agentAddress: "ins_srcsingle@example.com",
        sources: [makeInferenceSource("primary")],
        defaultSource: "primary",
      }),
    ).toBe(true);
  });

  test("does not register a sources-rotation handler for a multi-step deployment", async () => {
    const sourcesRouter = createMultistepSourcesRouter();
    const spawner = makeReadyDrivingSpawner(10700);
    const { router } = await buildMultistepFixture({
      spawner: spawner.spawner,
      multistepSourcesRouter: sourcesRouter,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-sources-multi-"),
      },
    });

    const frame = makeMultistepFrame({
      definition: {
        id: "wf-srcmulti",
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1", "step-2"],
        steps: { "step-1": { kind: "step" }, "step-2": { kind: "step" } },
      },
      sources: {
        "step-1": [makeInferenceSource("step-1")],
        "step-2": [makeInferenceSource("step-2")],
      },
    });
    const deployPromise = router.deploy(frame);
    await spawner.driveReadyFor(0);
    await deployPromise;

    // A multi-step deployment has no single warm agent to rotate, so no
    // handler is registered and the inbound rotation is unrouted.
    expect(
      await sourcesRouter.tryRoute({
        type: "sources.update",
        agentAddress: frame.agentAddress,
        sources: [makeInferenceSource("primary")],
        defaultSource: "primary",
      }),
    ).toBe(false);
  });

  test("a source rotation survives a recycle respawn", async () => {
    // End-to-end guard for the rotation-survives-recycle fix: the single-step
    // rotation handler mutates `currentSources`, `dynamicSpawnEnv`
    // re-serializes it, and the recycle respawn's STEP_INFERENCE_SOURCES
    // carries the ROTATED table -- not the frozen deploy-time one.
    const sourcesRouter = createMultistepSourcesRouter();
    const spawner = makeReadyDrivingSpawner(10800);
    const { router } = await buildMultistepFixture({
      spawner: spawner.spawner,
      multistepSourcesRouter: sourcesRouter,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-rot-survive-"),
      },
    });

    const addr = "ins_rotsurvive@example.com";
    const deployPromise = router.deploy(singleStepFrame(addr, "wf-rotsurvive"));
    await spawner.driveReadyFor(0);
    await deployPromise;

    // The initial spawn carries the deploy-time source table.
    const initialEnv = spawner.envFor(0);
    if (initialEnv === undefined) throw new Error("initial spawn env missing");
    expect(
      JSON.parse(initialEnv[STEP_INFERENCE_SOURCES_ENV_KEY] ?? "null"),
    ).toEqual({ "step-1": [makeInferenceSource("step-1")] });

    // Rotate the single-step deployment's sources in place.
    const rotated = makeInferenceSource("rotated");
    expect(
      await sourcesRouter.tryRoute({
        type: "sources.update",
        agentAddress: addr,
        sources: [rotated],
        defaultSource: "rotated",
      }),
    ).toBe(true);

    // The child asks to recycle; the supervisor respawns.
    await spawner.recycleRequestFor(0);
    while (spawner.spawnCount() < 2) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await spawner.driveReadyFor(1);

    // The recycle respawn's sources are the ROTATED table, proving the
    // rotation survived the recycle (before the fix it reverted to the
    // deploy-time list frozen in substrateEnv).
    const respawnEnv = spawner.envFor(1);
    if (respawnEnv === undefined) throw new Error("respawn env missing");
    expect(
      JSON.parse(respawnEnv[STEP_INFERENCE_SOURCES_ENV_KEY] ?? "null"),
    ).toEqual({ "step-1": [rotated] });
  });

  test("two addresses whose deriveDeploymentId slugs collide are rejected at the second deploy", async () => {
    // deriveDeploymentId substitutes every disallowed character with
    // `-`, so two distinct addresses can collapse to the same slug. The slug
    // IS the workflow-run repoId, so a silent collision would let the second
    // deploy overwrite the first deploy's repo state. claimSlug rejects the
    // second deploy at the router edge, before any spawn or repo write.
    const spawner = makeReadyDrivingSpawner(10400);
    const { router } = await buildMultistepFixture({
      spawner: spawner.spawner,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-collision-data-"),
      },
    });

    // `ins_col.a@example.com` and `ins_col-a@example.com` both project to
    // `ins_col-a-example-com` under the slug derivation.
    const deployPromise = router.deploy(
      singleStepFrame("ins_col.a@example.com", "wf-collide"),
    );
    await spawner.driveReadyFor(0);
    await deployPromise;

    await expect(
      router.deploy(singleStepFrame("ins_col-a@example.com", "wf-collide")),
    ).rejects.toThrow(/deriveDeploymentId collision/);
    expect(spawner.spawnCount()).toBe(1);
  });

  describe("assistant loop guard wiring (CL-3340 re-home)", () => {
    function inferenceDone(seq: number, text: string): EventPayload {
      return {
        type: "inference.done",
        seq,
        data: {
          turn: {
            role: "assistant",
            content: [{ type: "text", text }],
            model: "test-model",
            timestamp: seq,
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            thinking: 0,
          },
          source: { sourceId: "step-1", provider: "anthropic", model: "m" },
        },
      };
    }

    async function waitUntil(check: () => boolean): Promise<void> {
      const deadline = Date.now() + 2000;
      while (!check()) {
        if (Date.now() > deadline) {
          throw new Error("waitUntil timed out");
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    function abortedInterruptMessage(event: EventPayload): string | undefined {
      if (event.type !== "inference.error") return undefined;
      // `EventPayload` widens `custom.*` events' `type` to plain `string`
      // (arktype's regex-typed variant), which defeats TS discriminated-
      // union narrowing for the whole union; the runtime check above
      // already confirmed the discriminant, so re-assert against the
      // hand-written (properly literal-discriminated) `InferenceEvent`
      // union this same payload is validated against on the wire.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see comment above
      const narrowed = event as Extract<
        WireInferenceEvent,
        { type: "inference.error" }
      >;
      return narrowed.data.error.category === "aborted"
        ? narrowed.data.error.message
        : undefined;
    }

    function isAbortedInterrupt(event: EventPayload): boolean {
      return abortedInterruptMessage(event) !== undefined;
    }

    test("trips after the third identical inference.done cycle: publishes the interrupt notice and drains the deployment", async () => {
      const published: { address: string; event: EventPayload }[] = [];
      const spawner = makeReadyDrivingSpawner(11000);
      const { router } = await buildMultistepFixture({
        spawner: spawner.spawner,
        publishWorkflowInferenceEvent: (address, event) => {
          published.push({ address, event });
        },
        multistepSubstrateEnv: {
          SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-loopguard-trip-"),
        },
      });

      const addr = "ins_loopguard1@example.com";
      const deployPromise = router.deploy(singleStepFrame(addr, "wf-loop1"));
      await spawner.driveReadyFor(0);
      await deployPromise;

      await spawner.injectEvent(0, inferenceDone(1, "stuck in a loop"));
      await spawner.injectEvent(0, inferenceDone(2, "stuck in a loop"));
      await spawner.injectEvent(0, inferenceDone(3, "stuck in a loop"));

      await waitUntil(() => published.some((p) => isAbortedInterrupt(p.event)));
      const interrupt = published.find((p) => isAbortedInterrupt(p.event));
      if (interrupt === undefined) {
        throw new Error("expected an aborted inference.error event");
      }
      expect(abortedInterruptMessage(interrupt.event)).toBe(
        assistantLoopInterruptMessage(3),
      );

      await waitUntil(() =>
        spawner
          .controlFramesTo(0)
          .some((line) => JSON.parse(line).envelope.payload.type === "drain"),
      );
      const drainFrame = spawner
        .controlFramesTo(0)
        .map((line) => JSON.parse(line))
        .find((frame) => frame.envelope.payload.type === "drain");
      expect(drainFrame.envelope.payload.data.deadlineMs).toBe(0);
    });

    test("does not trip on three non-identical inference.done cycles", async () => {
      const published: { address: string; event: EventPayload }[] = [];
      const spawner = makeReadyDrivingSpawner(11100);
      const { router } = await buildMultistepFixture({
        spawner: spawner.spawner,
        publishWorkflowInferenceEvent: (address, event) => {
          published.push({ address, event });
        },
        multistepSubstrateEnv: {
          SIDECAR_DATA_DIR: await createTempBaseDir(
            "sidecar-loopguard-notrip-",
          ),
        },
      });

      const addr = "ins_loopguard2@example.com";
      const deployPromise = router.deploy(singleStepFrame(addr, "wf-loop2"));
      await spawner.driveReadyFor(0);
      await deployPromise;

      await spawner.injectEvent(0, inferenceDone(1, "step one"));
      await spawner.injectEvent(0, inferenceDone(2, "step two"));
      await spawner.injectEvent(0, inferenceDone(3, "step three"));

      // Give any (incorrect) async trip a chance to land before asserting
      // its absence.
      await new Promise((r) => setTimeout(r, 50));

      expect(published.some((p) => isAbortedInterrupt(p.event))).toBe(false);
      expect(
        spawner
          .controlFramesTo(0)
          .some((line) => JSON.parse(line).envelope.payload.type === "drain"),
      ).toBe(false);
    });

    test("an inbound mail message resets the run so two identical cycles before and after it never trip", async () => {
      const published: { address: string; event: EventPayload }[] = [];
      const mailRouter = createMultistepMailRouter();
      const spawner = makeReadyDrivingSpawner(11200);
      const { router } = await buildMultistepFixture({
        spawner: spawner.spawner,
        multistepMailRouter: mailRouter,
        publishWorkflowInferenceEvent: (address, event) => {
          published.push({ address, event });
        },
        multistepSubstrateEnv: {
          SIDECAR_DATA_DIR: await createTempBaseDir("sidecar-loopguard-reset-"),
        },
      });

      const addr = "ins_loopguard3@example.com";
      const deployPromise = router.deploy(singleStepFrame(addr, "wf-loop3"));
      await spawner.driveReadyFor(0);
      await deployPromise;

      await spawner.injectEvent(0, inferenceDone(1, "same reply"));
      await spawner.injectEvent(0, inferenceDone(2, "same reply"));
      // Let the event-channel pump actually deliver both cycles to the
      // guard (an `await sender.send(...)` only confirms the bytes were
      // written to the mock pipe, not that the async receive/HMAC-verify/
      // dispatch chain on the other end has run) before the reset below,
      // or the reset could race ahead of -- and so not actually cover --
      // cycle 2.
      await new Promise((r) => setTimeout(r, 50));

      // A fresh inbound message starts a new turn for the guard's
      // single-turn contract; it resets the repeat count before the two
      // more identical cycles below, so the total never reaches 3-in-a-row.
      mailRouter.tryRoute(addr, new TextEncoder().encode("noop"));

      await spawner.injectEvent(0, inferenceDone(3, "same reply"));
      await spawner.injectEvent(0, inferenceDone(4, "same reply"));

      await new Promise((r) => setTimeout(r, 50));

      expect(published.some((p) => isAbortedInterrupt(p.event))).toBe(false);
    });
  });
});
