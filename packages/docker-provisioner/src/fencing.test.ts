// Fencing/leak edge cases for the docker sidecar provisioner, adapted from
// the review critique that first demonstrated them. The first two cases
// used to prove real leaks (a second concurrent docker run, and an
// unkilled older-generation container); they now assert the fixed
// behavior — in-flight ensure dedup and obsolete-container sweeping —
// while the last two guard the fencing behavior that was already correct.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeCommandRunner } from "./fake-command-runner";
import { createDockerSidecarProvisioner } from "./interchange-plugin";
import { createAllocationStateStore } from "./state-store";

const IMAGE = "ghcr.io/corbits/sidecar:latest";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "docker-provisioner-fencing-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    allocationId: "alloc-1",
    generation: 1,
    tenantId: "tenant-1",
    anchorRunId: "run-1",
    sidecarId: "sidecar-1",
    token: "tok",
    hubWebSocketUrl: "wss://hub.example.com/ws",
    ...overrides,
  };
}

describe("fencing edge cases", () => {
  test("concurrent ensure at the same generation does not leak a container", async () => {
    let runCount = 0;
    let releaseFirstRun: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolveGate) => {
      releaseFirstRun = resolveGate;
    });
    const commands = createFakeCommandRunner(async (args) => {
      if (args[0] === "run") {
        runCount += 1;
        const id = `container-${String(runCount)}`;
        if (runCount === 1) await firstRunGate;
        return { stdout: `${id}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const store = createAllocationStateStore(join(dataDir, "state.json"));
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    const first = provisioner.ensure(request());
    // Give the first call time to pass observeEnsure and block in docker run.
    await new Promise((r) => setTimeout(r, 20));
    const second = provisioner.ensure(request());
    await new Promise((r) => setTimeout(r, 20));
    releaseFirstRun?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const runs = commands.calls.filter((call) => call[0] === "run");
    // The in-flight ensure map coalesces the second call onto the first:
    // only one docker run, and both callers see the same container.
    expect(runs.length).toBe(1);
    expect(firstResult).toEqual(secondResult);
    const record = await store.getRecord("alloc-1");
    expect(record?.containerId).toBe("container-1");
  });

  test("newer-generation ensure removes the older generation's container", async () => {
    let runCount = 0;
    const liveContainers = new Set<string>();
    const commands = createFakeCommandRunner(async (args) => {
      if (args[0] === "run") {
        runCount += 1;
        const id = `container-${String(runCount)}`;
        liveContainers.add(id);
        return { stdout: `${id}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") {
        return {
          stdout:
            liveContainers.size > 0
              ? `${Array.from(liveContainers).join("\n")}\n`
              : "",
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "rm") {
        liveContainers.delete(args[1] ?? "");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const store = createAllocationStateStore(join(dataDir, "state.json"));
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    await provisioner.ensure(request({ generation: 1 }));
    await provisioner.ensure(request({ generation: 2 }));

    const stops = commands.calls.filter((call) => call[0] === "stop");
    // The generation-2 ensure sweeps every container still labeled for
    // this allocation other than its own — container-1 (gen 1) is
    // stopped and removed, leaving only container-2 recorded.
    expect(stops).toContainEqual(["stop", "container-1"]);
    expect(stops).not.toContainEqual(["stop", "container-2"]);
    const record = await store.getRecord("alloc-1");
    expect(record?.containerId).toBe("container-2");
  });

  test("destroy at a newer generation than the record still removes the recorded container", async () => {
    const commands = createFakeCommandRunner(async (args) => {
      if (args[0] === "run") {
        return { stdout: "container-1\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const store = createAllocationStateStore(join(dataDir, "state.json"));
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });
    await provisioner.ensure(request({ generation: 1 }));

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });

    expect(result).toEqual({ kind: "destroyed" });
    expect(commands.calls).toContainEqual(["stop", "container-1"]);
  });

  test("older ensure after a newer destroy is fenced", async () => {
    const commands = createFakeCommandRunner(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const store = createAllocationStateStore(join(dataDir, "state.json"));
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });
    await provisioner.destroy({
      allocationId: "alloc-1",
      sidecarId: "sidecar-1",
      generation: 2,
    });

    const result = await provisioner.ensure(request({ generation: 1 }));

    expect(result).toMatchObject({
      kind: "rejected",
      code: "stale_generation",
    });
    expect(commands.calls.filter((c) => c[0] === "run")).toHaveLength(0);
  });
});
