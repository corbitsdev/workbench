// CL-2231: the multi-step undeploy hook must reclaim the deployment's
// on-disk footprint so workflow deployment churn (supersede/redeploy +
// DELETE) does not exhaust the sidecar volume's inodes. Two things leak
// without this and nothing else reclaims them:
//   1. the per-deployment workflow-run repo (a `workflow-run` repo, not an
//      agent dir, so no undeploy path touches it), and
//   2. each step's on-disk dirs (interchange's undeploy only deletes a step
//      agent's dir while CONNECTED; idle-evicted steps orphan forever).
//
// The harness drives a real multi-step deploy through the same spawn
// handshake the supervisor-shutdown test uses, materializes the deployment's
// on-disk dirs under a real temp SIDECAR_DATA_DIR, then asserts `undeploy`
// removes every owned dir while leaving an unrelated deployment's dirs
// intact. A negative test confirms undeploy is idempotent when the dirs are
// already absent.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEd25519Crypto, generateKeyPair } from "@intx/crypto";
import { createInMemoryTransport } from "@intx/mail-memory";
import type { RepoId, RepoStore } from "@intx/hub-sessions";
import {
  createControlChannelSender,
  type FrameReader,
  type NdjsonReader,
  type NdjsonWriter,
  type SubprocessHandle,
  type SubprocessSpawner,
} from "@workbench/workflow-host";
import type { AgentDeployFrame } from "@intx/types/sidecar";

import { createSidecarDeployRouter } from "./workflow-host-wiring";
import {
  createMultistepDrainRouter,
  createMultistepMailRouter,
  createMultistepSignalRouter,
} from "./workflow-run-pack-client";

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

// Replicate interchange's `sanitizeAddress` (hub-agent agent-paths.ts) so the
// test computes the same step-agent dir name the production hook does.
function sanitizeAgentAddress(address: string): string {
  return address.replace(/@/g, "_at_").replace(/[^a-zA-Z0-9_-]/g, "_");
}

// A RepoStore stub whose `getRepoDir` mirrors the real substrate's pure path
// computation: `${dataDir}/${directoryPrefix}/${id}`. The two kinds the
// undeploy reclaim path resolves are `workflow-run` (prefix `workflow-runs`)
// and `agent-state` (prefix `agents`).
function createReclaimTestRepoStore(dataDir: string): RepoStore {
  const prefixes: Record<string, string> = {
    "workflow-run": "workflow-runs",
    "agent-state": "agents",
    workflow: "assets/workflow",
  };
  const stub: Partial<RepoStore> = {
    getRepoDir(repoId: RepoId): string {
      const prefix = prefixes[repoId.kind] ?? repoId.kind;
      return path.join(dataDir, prefix, repoId.id);
    },
    async writeTreePreservingPrefix(_p, _id, _ref, args) {
      await args.merge(new Map());
      return { commitSha: "stub-sha", newlyTerminalRuns: [] };
    },
    // The deploy router's grants bridge writes `state/grants.json` to each
    // step's agent-state repo before `spawn()`. The reclaim path does not
    // read these back, so a no-op write that lands a commit is sufficient.
    async writeTree() {
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

interface DeployHarness {
  router: ReturnType<typeof createSidecarDeployRouter>;
  dataDir: string;
  rawDeploymentId: string;
  deploymentId: string;
  stepIds: readonly string[];
  agentAddress: string;
  /** Absolute dirs the deployment owns and the hook must reclaim. */
  ownedDirs: string[];
}

// `deriveTrivialDeploymentId` slug used by the router: the agent address's
// local-part + slugified domain. For `<local>@example.com` this is
// `<local>-example-com`. Mirrored here so the test can compute the dirs.
function slugDeploymentId(agentAddress: string): string {
  const [local, domain] = agentAddress.split("@");
  if (local === undefined || domain === undefined) {
    throw new Error("test agent address must be local@domain");
  }
  return `${local}-${domain.replace(/\./g, "-")}`;
}

async function standUpDeployment(
  agentAddress: string,
  rawDeploymentId: string,
  stepIds: readonly string[],
): Promise<DeployHarness> {
  const spawns: {
    handle: SubprocessHandle;
    childToSupervisor: ReturnType<typeof createMemoryNdjsonStream>;
    env: Record<string, string>;
  }[] = [];

  const spawner: SubprocessSpawner = ({ env }) => {
    const supervisorToChild = createMemoryNdjsonStream();
    const childToSupervisor = createMemoryNdjsonStream();
    const eventChildToSupervisor = createMemoryFrameStream();
    let resolveExit: ((code: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const handle: SubprocessHandle = {
      pid: 6000 + spawns.length,
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
    spawns.push({ handle, childToSupervisor, env });
    return handle;
  };

  const transport = createInMemoryTransport();
  const keyPair = await generateKeyPair();
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "sidecar-reclaim-data-"),
  );
  const repoStore = createReclaimTestRepoStore(dataDir);

  const router = createSidecarDeployRouter({
    sessions: {
      provisionAgent: async () => {
        throw new Error("multi-step branch must not invoke provisionAgent");
      },
      persistHubPublicKey: async () => {
        throw new Error(
          "multi-step branch must not invoke persistHubPublicKey",
        );
      },
    } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["sessions"],

    keyStore: {
      recordHubKey: () => {
        throw new Error("multi-step branch must not invoke recordHubKey");
      },
      loadOrGenerateKey: async () => ({ keyPair, isNew: false }),
    } as unknown as Parameters<typeof createSidecarDeployRouter>[0]["keyStore"],
    onAgentEvent: () => () => {
      /* unused */
    },
    transport,
    repoStore,
    signingKeySeed: keyPair.privateKey,
    createAgentCrypto: createEd25519Crypto,
    registerDeployment: () => {
      /* no-op */
    },
    unregisterDeployment: () => {
      /* no-op */
    },
    multistepSubprocessSpawner: spawner,
    // Mirror the real boot-edge substrate env (see index.ts) so the deploy
    // router's CL-2363 completeness assertion passes.
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
    multistepMailRouter: createMultistepMailRouter(),
    multistepSignalRouter: createMultistepSignalRouter(),
    multistepDrainRouter: createMultistepDrainRouter(),
  });

  const steps: Record<string, { kind: string }> = {};
  const sources: Record<string, unknown> = {};
  for (const stepId of stepIds) {
    steps[stepId] = { kind: "step" };
    sources[stepId] = {
      id: stepId,
      provider: "anthropic",
      baseURL: "https://api.anthropic.com",
      apiKey: `sk-${stepId}`,
      model: "claude-3-5",
    };
  }

  const frame: AgentDeployFrame = {
    type: "agent.deploy",
    agentAddress,
    agentId: `ins_${rawDeploymentId}`,
    hubPublicKey: "hub-pk",

    config: { tenantId: "ten_test" } as AgentDeployFrame["config"],
    workflow: {
      definition: {
        id: `wf-${rawDeploymentId}`,
        triggers: [{ type: "manual" }],
        stepOrder: [...stepIds],
        steps,
      },

      sources: sources as NonNullable<AgentDeployFrame["workflow"]>["sources"],
    },
  };

  const deployPromise = router.deploy(frame);
  while (spawns.length === 0) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const spawn = spawns[0];
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
      childPublicKey: Buffer.from(childIpcKeyPair.publicKey).toString("hex"),
    },
  });
  await deployPromise;

  const deploymentId = slugDeploymentId(agentAddress);
  // The supervisor (and so the reclaim sweep) keys each step's agent-state
  // repo and mail address by the SLUG deploymentId via `deriveStepRepoId` /
  // `deriveStepAddress` -- `<slug>-<stepId>` for a derived multi-step deploy.
  const ownedDirs: string[] = [
    path.join(dataDir, "workflow-runs", deploymentId),
  ];
  for (const stepId of stepIds) {
    ownedDirs.push(path.join(dataDir, "agents", `${deploymentId}-${stepId}`));
    const stepAddress = `${deploymentId}-${stepId}`;
    ownedDirs.push(path.join(dataDir, sanitizeAgentAddress(stepAddress)));
  }

  return {
    router,
    dataDir,
    rawDeploymentId,
    deploymentId,
    stepIds,
    agentAddress,
    ownedDirs,
  };
}

async function materialize(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "marker"), "x", "utf8");
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("createSidecarDeployRouter multi-step undeploy reclaims on-disk footprint (CL-2231)", () => {
  test("removes the workflow-run repo + every per-step dir, leaving an unrelated deployment untouched", async () => {
    const harness = await standUpDeployment(
      "reclaim-a@example.com",
      "ses_reclaimA",
      ["step-1", "step-2"],
    );
    await materialize(harness.ownedDirs);

    // An unrelated deployment's dirs under the SAME data dir; the sweep must
    // not touch these.
    const unrelated = [
      path.join(harness.dataDir, "workflow-runs", "other-example-com"),
      path.join(harness.dataDir, "agents", "ses_other-step-1"),
      path.join(
        harness.dataDir,
        sanitizeAgentAddress("other-example-com-step-1"),
      ),
    ];
    await materialize(unrelated);

    for (const dir of harness.ownedDirs) {
      expect(await exists(dir)).toBe(true);
    }

    const undeploy = harness.router.undeploy;
    if (undeploy === undefined) throw new Error("router.undeploy is undefined");
    await undeploy({
      type: "agent.undeploy",
      agentAddress: harness.agentAddress,
      reason: "test undeploy",
    });

    for (const dir of harness.ownedDirs) {
      expect(await exists(dir)).toBe(false);
    }
    for (const dir of unrelated) {
      expect(await exists(dir)).toBe(true);
    }
  });

  test("is idempotent: undeploy does not throw when the owned dirs are already absent", async () => {
    const harness = await standUpDeployment(
      "reclaim-b@example.com",
      "ses_reclaimB",
      ["step-1", "step-2"],
    );
    // Deliberately do NOT materialize the owned dirs.
    for (const dir of harness.ownedDirs) {
      expect(await exists(dir)).toBe(false);
    }

    const undeploy = harness.router.undeploy;
    if (undeploy === undefined) throw new Error("router.undeploy is undefined");
    await undeploy({
      type: "agent.undeploy",
      agentAddress: harness.agentAddress,
      reason: "test undeploy idempotent",
    });

    for (const dir of harness.ownedDirs) {
      expect(await exists(dir)).toBe(false);
    }
  });
});
