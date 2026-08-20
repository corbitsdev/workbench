// Shared test scaffolding for exercising `createSidecarDeployRouter`
// end-to-end against a mock workflow-process child: an in-memory
// NDJSON control channel, an in-memory event-channel frame stream, and a
// minimal `RepoStore` stub that answers only the calls the deploy router's
// grants bridge and credentials snapshot assembly make. Shared by every
// test that exercises `createSidecarDeployRouter` end-to-end so none of
// them reinvent the mock child handshake.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { hexEncode } from "@intx/types";
import { createInMemoryTransport } from "@intx/mail-memory";
import type { RepoId, RepoStore } from "@intx/hub-sessions";
import {
  createControlChannelSender,
  type FrameReader,
  type NdjsonReader,
  type NdjsonWriter,
  type SubprocessHandle,
  type SubprocessSpawner,
} from "@intx/workflow-host";
import type { AgentDeployFrame } from "@intx/types/sidecar";

import {
  createSidecarDeployRouter,
  type SidecarDeployRouter,
} from "../../src/workflow-host-wiring";
import {
  createMultistepCredentialsRouter,
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
  createMultistepSourcesRouter,
  type MultistepCredentialsRouter,
  type MultistepDrainRouter,
  type MultistepMailRouter,
  type MultistepSignalRouter,
  type MultistepSourcesRouter,
} from "../../src/workflow-run-pack-client";

export function createMemoryNdjsonStream() {
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
    close() {
      done = true;
      wake();
    },
  };
}

export function createMemoryFrameStream() {
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

export function createSpawnTestRepoStore(tempBase: string): RepoStore {
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
  // Boundary type assertion: test stub
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

// Per-spawn tracking the mock spawner records.
export type Spawn = {
  handle: SubprocessHandle;
  childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
  supervisorToChild: ReturnType<typeof createMemoryNdjsonStream>;
  eventChildToSupervisor: ReturnType<typeof createMemoryFrameStream>;
  /** Every line the supervisor wrote to the child's control channel, in order. */
  sentControlLines: string[];
  env: Record<string, string>;
  killed: boolean;
  exitedResolved: boolean;
  resolveExited: (code: number) => void;
};

export type Fixture = {
  router: SidecarDeployRouter;
  spawns: Spawn[];
  dataDir: string;
  repoStore: RepoStore;
  multistepMailRouter: MultistepMailRouter;
  multistepSignalRouter: MultistepSignalRouter;
  multistepDrainRouter: MultistepDrainRouter;
  multistepSourcesRouter: MultistepSourcesRouter;
  multistepCredentialsRouter: MultistepCredentialsRouter;
};

export async function makeLifecycleFixture(opts?: {
  /**
   * Reuse a prior fixture's data dir, so a test can construct a SECOND
   * router against the SAME on-disk state to model a sidecar process
   * restart (boot-time restore).
   */
  dataDir?: string;
}): Promise<Fixture> {
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
      // Boundary type assertion: assigned below
      handle: undefined as unknown as SubprocessHandle,
      supervisorToChild,
      childToSupervisor,
      eventChildToSupervisor,
      sentControlLines: [],
      env,
      killed: false,
      exitedResolved: false,
      resolveExited: (code) => {
        entry.exitedResolved = true;
        resolveExit?.(code);
      },
    };
    const handle: SubprocessHandle = {
      pid: 5100 + spawns.length,
      controlWriter: {
        async write(line: string) {
          entry.sentControlLines.push(line);
          await supervisorToChild.writer.write(line);
        },
      },
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
    path.join(os.tmpdir(), "sidecar-lifecycle-repos-"),
  );
  const dataDir =
    opts?.dataDir ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "sidecar-lifecycle-data-")));
  const repoStore = createSpawnTestRepoStore(tempBase);

  const multistepMailRouter = createMultistepMailRouter();
  const multistepSignalRouter = createMultistepSignalRouter();
  const multistepDrainRouter = createMultistepDrainRouter();
  const multistepSourcesRouter = createMultistepSourcesRouter();
  const multistepCredentialsRouter = createMultistepCredentialsRouter();

  const router = createSidecarDeployRouter({
    // Boundary type assertion: the single-step branch invokes only initRepo (head deploy-tree repo); provisionAgent/persistHubPublicKey stay unused (the supervised child mints its own key and persists no hub-agent config)
    sessions: {
      provisionAgent: async () => {
        throw new Error("single-step branch must not invoke provisionAgent");
      },
      persistHubPublicKey: async () => {
        throw new Error(
          "single-step branch must not invoke persistHubPublicKey",
        );
      },
      initRepo: async () => undefined,
    } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["sessions"],
    // Boundary type assertion: the single-step branch registers the agent's signing key (loadOrGenerateKey) and records the hub key (recordHubKey) at the head before spawn
    keyStore: {
      recordHubKey: () => undefined,
      forgetAgent: () => undefined,
      loadOrGenerateKey: async () => ({
        keyPair: await generateKeyPair(),
        isNew: false,
      }),
    } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["keyStore"],
    transport,
    repoStore,
    signingKeySeed: keyPair.privateKey,
    createAgentCrypto: createEd25519Crypto,
    assertSourceBuildable: () => undefined,
    registerDeployment: () => {
      /* no-op */
    },
    unregisterDeployment: () => {
      /* no-op */
    },
    multistepSubprocessSpawner: spawner,
    multistepSubstrateEnv: {
      SIDECAR_DATA_DIR: dataDir,
    },
    multistepMailRouter,
    multistepSignalRouter,
    multistepDrainRouter,
    multistepSourcesRouter,
    multistepCredentialsRouter,
  });
  return {
    router,
    spawns,
    dataDir,
    repoStore,
    multistepMailRouter,
    multistepSignalRouter,
    multistepDrainRouter,
    multistepSourcesRouter,
    multistepCredentialsRouter,
  };
}

export function makeWorkflowFrame(agentAddress: string): AgentDeployFrame {
  return {
    type: "agent.deploy",
    // Single-step projection: the deploy router derives the sole
    // step's agent-state repo from `parseAgentId(agentAddress)`, which
    // requires the canonical `ins_<id>@<domain>` instance shape.
    agentAddress,
    agentId: "lifecycle-agent",
    hubPublicKey: "hub-pk",
    // Boundary type assertion: the multi-step branch does not read config
    config: {} as AgentDeployFrame["config"],
    workflow: {
      definition: {
        id: "wf-lifecycle",
        triggers: [{ type: "manual" }],
        stepOrder: ["step-1"],
        steps: { "step-1": { kind: "step" } },
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
}

/**
 * Drive the mock child's half of the supervisor's spawn handshake: wait
 * for the spawner to fire, then send a signed `ready` envelope over the
 * recorded control channel so `supervisor.spawn()` resolves.
 */
export async function answerReadyHandshake(spawns: Spawn[], at: number) {
  while (spawns.length <= at) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const spawn = spawns[at];
  if (spawn === undefined) throw new Error("unreachable");
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
      childPublicKey: hexEncode(childIpcKeyPair.publicKey),
    },
  });
  return spawn;
}
