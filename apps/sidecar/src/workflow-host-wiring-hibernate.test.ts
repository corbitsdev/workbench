// WORKBENCH-LOCAL (CL-3104) test file.
//
// Pins the hibernate flavor of the multi-step deploy router teardown: a
// long-parked (awaiting) run's deployment is torn down to free the child
// subprocess and supervisor residency, but every piece of durable on-disk
// state survives — the workflow-run repo, each step's agent-state repo, the
// per-step scratch, and the durable conversation. This is the exact opposite
// of `undeploy`'s reclaim sweep, whose deletions this test proves are
// SKIPPED. It then drives the wake path: a re-deploy at the same address
// (what the hub's signal-path `ensureDeploymentRoutable` re-sends) spawns a
// fresh child, and a signal routed at the deployment reaches the new child
// over the control channel — the seam the parked run's resume
// (`recoverParkedRun` / the live signal watcher) hangs off.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { createInMemoryTransport } from "@intx/mail-memory";
import type { RepoId, RepoStore } from "@workbench/hub-sessions";
import {
  createControlChannelSender,
  type FrameReader,
  type NdjsonReader,
  type NdjsonWriter,
  type SubprocessHandle,
  type SubprocessSpawner,
} from "@workbench/workflow-host";
import type { AgentDeployFrame } from "@intx/types/sidecar";

// A minimal step-agent tag pair, filler content for the generic step fixture
// below — not an import from `@workbench/agents` (the retired
// `deterministicToolStep`'s tags are deleted); this test only needs SOME
// step shape, not this specific one.
const STEP_KIND_TAG = "workbench.stepKind";
const DETERMINISTIC_TOOL_KIND = "deterministic-tool";

import {
  createSidecarDeployRouter,
  deriveDeploymentId,
} from "./workflow-host-wiring";
import {
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
} from "./workflow-run-pack-client";

function createMemoryNdjsonStream() {
  const buffer: string[] = [];
  const lines: string[] = [];
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
      const clean = line.replace(/\n$/, "");
      buffer.push(clean);
      lines.push(clean);
      wake();
      return Promise.resolve();
    },
  };
  return {
    writer,
    reader,
    // Every line ever written (the reader consumes `buffer`; assertions
    // read this stable record instead).
    lines,
    inject(line: string) {
      buffer.push(line.replace(/\n$/, ""));
      wake();
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
    close() {
      done = true;
      wake();
    },
  };
}

function createSpawnTestRepoStore(tempBase: string): RepoStore {
  const stub: Partial<RepoStore> = {
    getRepoDir(repoId: RepoId): string {
      return path.join(tempBase, repoId.kind, repoId.id);
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      await args.merge(new Map());
      return { commitSha: "stub-sha", newlyTerminalRuns: [] };
    },
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

describe("createSidecarDeployRouter hibernate", () => {
  test("hibernate kills the child and releases routing but preserves all durable state; a re-deploy + signal wakes it", async () => {
    type Spawn = {
      handle: SubprocessHandle;
      childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
      supervisorToChild: ReturnType<typeof createMemoryNdjsonStream>;
      eventChildToSupervisor: ReturnType<typeof createMemoryFrameStream>;
      env: Record<string, string>;
      killed: boolean;
      exitedResolved: boolean;
      resolveExited: (code: number) => void;
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
      const entry: Spawn = {
        handle: undefined as unknown as SubprocessHandle,
        supervisorToChild,
        childToSupervisor,
        eventChildToSupervisor,
        env,
        killed: false,
        exitedResolved: false,
        resolveExited: (code) => {
          entry.exitedResolved = true;
          resolveExit?.(code);
        },
      };
      const handle: SubprocessHandle = {
        pid: 6100 + spawns.length,
        controlWriter: supervisorToChild.writer,
        controlReader: childToSupervisor.reader,
        eventReader: eventChildToSupervisor.reader,
        kill: () => {
          entry.killed = true;
          childToSupervisor.close();
          eventChildToSupervisor.close();
          entry.resolveExited(0);
        },
        exited,
      };
      entry.handle = handle;
      spawns.push(entry);
      return handle;
    };

    const transport = createInMemoryTransport();
    const keyPair = await generateKeyPair();
    const tempBase = await fs.mkdtemp(
      path.join(os.tmpdir(), "sidecar-hibernate-"),
    );
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "sidecar-hibernate-data-"),
    );
    const repoStore = createSpawnTestRepoStore(tempBase);

    const mailRouter = createMultistepMailRouter();
    const signalRouter = createMultistepSignalRouter();
    const drainRouter = createMultistepDrainRouter();

    const unregistered: string[] = [];
    const drained: string[] = [];

    const router = createSidecarDeployRouter({
      sessions: {
        // Single-step (warm) deploy stages its deploy tree at the head via the
        // narrow initRepo seam, not provisionAgent.
        initRepo: async () => {
          /* no-op: no on-disk deploy tree needed for this test */
        },
        provisionAgent: async () => {
          throw new Error("workflow deploy must not invoke provisionAgent");
        },
        persistHubPublicKey: async () => {
          throw new Error(
            "workflow deploy must not invoke persistHubPublicKey",
          );
        },
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["sessions"],
      keyStore: {
        // Single-step head records the hub key so the deploy pack verifies.
        recordHubKey: () => {
          /* no-op */
        },
        forgetAgent: () => {
          /* no-op unwind */
        },
        loadOrGenerateKey: async () => ({
          keyPair: await generateKeyPair(),
          isNew: false,
        }),
      } as unknown as Parameters<
        typeof createSidecarDeployRouter
      >[0]["keyStore"],
      transport,
      repoStore,
      signingKeySeed: keyPair.privateKey,
      createAgentCrypto: createEd25519Crypto,
      assertSourceBuildable: () => {
        /* every source buildable in this test */
      },
      registerDeployment: () => {
        /* no-op */
      },
      unregisterDeployment: ({ deploymentId }) => {
        unregistered.push(deploymentId);
      },
      drainWorkflowRunPushes: (deploymentId) => {
        drained.push(deploymentId);
        return Promise.resolve();
      },
      multistepSubprocessSpawner: spawner,
      multistepSubstrateEnv: {
        SIDECAR_DATA_DIR: dataDir,
        SIDECAR_SIGNING_PUBLIC_KEY: "deadbeef",
        SIDECAR_SIGNING_PRIVATE_KEY: "cafef00d",
        HUB_WS_URL: "ws://hub.test/ws",
        SIDECAR_ID: "sc_test",
        SIDECAR_TOKEN: "tok_test",
        SIDECAR_CACHE_MAX_BYTES: "1000000",
        SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "1000000",
        SIDECAR_ADAPTER_MANIFEST: "[]",
      },
      multistepMailRouter: mailRouter,
      multistepSignalRouter: signalRouter,
      multistepDrainRouter: drainRouter,
    });

    const frame: AgentDeployFrame = {
      type: "agent.deploy",
      agentAddress: "ins_hibernate-parked@example.com",
      agentId: "ins_hibernate-parked-agent",
      hubPublicKey: "hub-pk",
      config: {
        tenantId: "ten_test",
        principalId: "prn_test",
      } as AgentDeployFrame["config"],
      workflow: {
        definition: {
          id: "wf-hibernate",
          triggers: [{ type: "manual" }],
          stepOrder: ["step-1"],
          steps: {
            "step-1": {
              kind: "step",
              agent: {
                tags: { [STEP_KIND_TAG]: DETERMINISTIC_TOOL_KIND },
              },
            },
          },
        },
        sources: {
          "step-1": [
            {
              id: "step-1",
              provider: "anthropic",
              baseURL: "https://api.anthropic.com",
              apiKey: "sk-step-1",
              model: "claude-3-5",
            },
          ],
        },
      },
    };

    async function completeSpawnHandshake(spawn: Spawn): Promise<void> {
      const channelId = spawn.env.IPC_CHANNEL_ID;
      if (channelId === undefined) {
        throw new Error("IPC_CHANNEL_ID missing from spawn env");
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
      await childSender.send({
        type: "ready",
        data: {
          childPid: spawn.handle.pid,
          childPublicKey: Buffer.from(childIpcKeyPair.publicKey).toString(
            "hex",
          ),
        },
      });
    }

    const deployPromise = router.deploy(frame);
    while (spawns.length === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const first = spawns[0];
    if (first === undefined) throw new Error("unreachable");
    await completeSpawnHandshake(first);
    await deployPromise;

    const deploymentId = deriveDeploymentId(frame.agentAddress);

    // Durable state the hibernate MUST preserve: the workflow-run repo
    // (the parked run's event log lives here), the step's agent-state repo
    // (grants were written to it at deploy), the per-step scratch, and the
    // durable conversation.
    const workflowRunDir = path.join(tempBase, "workflow-run", deploymentId);
    await fs.mkdir(workflowRunDir, { recursive: true });
    await fs.writeFile(path.join(workflowRunDir, "events.jsonl"), "{}");
    const stepStateFile = path.join(
      dataDir,
      "workflow-step-state",
      deploymentId,
      "warm",
      "step-1",
      "workspace",
      "notes.txt",
    );
    const conversationFile = path.join(
      dataDir,
      "agent-conversation-state",
      deploymentId,
      "step-1",
      "checkpoint.json",
    );
    for (const file of [stepStateFile, conversationFile]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "x");
    }
    // The step's agent-state repo dir exists via the deploy's grants write.
    const agentStateDirs = (
      await fs.readdir(path.join(tempBase, "agent-state"))
    ).sort();
    expect(agentStateDirs.length).toBeGreaterThan(0);

    const hibernate = router.hibernate;
    if (hibernate === undefined) {
      throw new Error("router.hibernate is undefined");
    }

    await hibernate({
      type: "agent.undeploy",
      agentAddress: frame.agentAddress,
      reason: "hibernate test",
    });

    expect(() => transport.getTransportFor(frame.agentAddress)).toThrow(
      /not registered/,
    );

    // Residency is gone: the child was killed and its exit awaited, the
    // drain barrier ran, and the deployment mapping was released.
    expect(first.killed).toBe(true);
    expect(first.exitedResolved).toBe(true);
    expect(drained).toEqual([deploymentId]);
    expect(unregistered).toEqual([deploymentId]);

    // A signal at the hibernated deployment is rejected at the router
    // boundary (the hub re-establishes BEFORE delivering, so this frame
    // models a stray delivery, not the wake path).
    expect(
      await signalRouter.tryRoute({
        type: "signal.deliver",
        agentAddress: frame.agentAddress,
        runId: "run-1",
        signalName: "approval",
        signalId: "sig-1",
        payload: {},
      }),
    ).toBe(false);

    // Every piece of durable state survives — hibernation is NOT undeploy.
    expect(
      await fs.readFile(path.join(workflowRunDir, "events.jsonl"), "utf8"),
    ).toBe("{}");
    expect(await fs.readFile(stepStateFile, "utf8")).toBe("x");
    expect(await fs.readFile(conversationFile, "utf8")).toBe("x");
    expect(
      (await fs.readdir(path.join(tempBase, "agent-state"))).sort(),
    ).toEqual(agentStateDirs);

    // Wake: the hub's signal path re-sends agent.deploy for an unroutable
    // deployment. The same frame must deploy cleanly again (slug re-claim,
    // fresh supervisor, fresh child)...
    const redeployPromise = router.deploy(frame);
    while (spawns.length < 2) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const second = spawns[1];
    if (second === undefined) throw new Error("unreachable");
    await completeSpawnHandshake(second);
    await redeployPromise;

    expect(() => transport.getTransportFor(frame.agentAddress)).not.toThrow();

    // ...and the gate signal now routes into the fresh child over the
    // control channel (the child-side resume of the parked run from the
    // durable log is pinned by the workflow-host recoverParkedRun tests).
    expect(
      await signalRouter.tryRoute({
        type: "signal.deliver",
        agentAddress: frame.agentAddress,
        runId: "run-1",
        signalName: "approval",
        signalId: "sig-1",
        payload: { approved: true },
      }),
    ).toBe(true);
    const signalLine = second.supervisorToChild.lines.find((line) =>
      line.includes("signal.deliver"),
    );
    expect(signalLine).toBeString();

    // Repeatable across gates: hibernate the woken deployment again and
    // confirm the same state-preserving teardown applies to the fresh child.
    await hibernate({
      type: "agent.undeploy",
      agentAddress: frame.agentAddress,
      reason: "hibernate test second gate",
    });
    expect(second.killed).toBe(true);
    expect(await fs.readFile(stepStateFile, "utf8")).toBe("x");
    expect(
      await fs.readFile(path.join(workflowRunDir, "events.jsonl"), "utf8"),
    ).toBe("{}");

    // Orphan self-heal: a hibernate whose ack path failed leaves the hub
    // believing the deployment is down while the child is still resident
    // (interchange's undeploy timeout arm unroutes before rejecting); the
    // wake then re-sends agent.deploy at the live supervisor.
    //
    // WORKBENCH-LOCAL (deploy-timeout fix): re-ack the existing agent key
    // without teardown/re-spawn. A full kill+spawn on the warm path was
    // exceeding the hub's 30s deploy wait under concurrent session
    // launches; re-ack recovers routing in O(ms) against the live child.
    const thirdDeploy = router.deploy(frame);
    while (spawns.length < 3) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const third = spawns[2];
    if (third === undefined) throw new Error("unreachable");
    await completeSpawnHandshake(third);
    await thirdDeploy;

    // Second deploy against the now-live third child: no fourth spawn, no kill.
    const fourth = await router.deploy(frame);
    expect(spawns.length).toBe(3);
    expect(third.killed).toBe(false);
    expect(fourth.publicKey).toBeString();
    // Durable state still intact (no reclaim happened)...
    expect(await fs.readFile(stepStateFile, "utf8")).toBe("x");
    expect(
      await fs.readFile(path.join(workflowRunDir, "events.jsonl"), "utf8"),
    ).toBe("{}");
    // ...and the resident third child still owns routing.
    expect(
      await signalRouter.tryRoute({
        type: "signal.deliver",
        agentAddress: frame.agentAddress,
        runId: "run-1",
        signalName: "approval",
        signalId: "sig-2",
        payload: {},
      }),
    ).toBe(true);
    expect(
      third.supervisorToChild.lines.find((line) =>
        line.includes("signal.deliver"),
      ),
    ).toBeString();
  });
});
