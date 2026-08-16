import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeCommandRunner, type FakeCommandRunner } from "./fake-command-runner";
import { createDockerSidecarProvisioner } from "./interchange-plugin";
import { createAllocationStateStore, type AllocationStateStore } from "./state-store";

const IMAGE = "ghcr.io/corbits/sidecar:latest";
const TOKEN = "s3cr3t-bootstrap-token";

let dataDir: string;
let store: AllocationStateStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "docker-provisioner-plugin-"));
  store = createAllocationStateStore(join(dataDir, "state.json"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function ensuredRunner(containerId: string): FakeCommandRunner {
  return createFakeCommandRunner(async (args) => {
    if (args[0] === "run") {
      return { stdout: `${containerId}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

function baseEnsureRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    allocationId: "alloc-1",
    generation: 1,
    tenantId: "tenant-1",
    anchorRunId: "run-1",
    sidecarId: "sidecar-1",
    token: TOKEN,
    hubWebSocketUrl: "wss://hub.example.com/ws",
    ...overrides,
  };
}

describe("ensure", () => {
  test("runs docker run -d with the image, labels, and env vars", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    const result = await provisioner.ensure(baseEnsureRequest());

    expect(result).toEqual({ kind: "accepted", externalRef: "container-abc" });
    const runCall = commands.calls.find((call) => call[0] === "run");
    expect(runCall).toEqual([
      "run",
      "-d",
      "--label",
      "corbits.allocationId=alloc-1",
      "--label",
      "corbits.sidecarId=sidecar-1",
      "-e",
      "HUB_WS_URL=wss://hub.example.com/ws",
      "-e",
      `SIDECAR_TOKEN=${TOKEN}`,
      "-e",
      "SIDECAR_ID=sidecar-1",
      "-e",
      "SIDECAR_DATA_DIR=/home/sidecar/interchange-sidecar-data",
      IMAGE,
    ]);
  });

  test("never logs or persists the raw token; only its hash is stored", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    await provisioner.ensure(baseEnsureRequest());

    const raw = await readFile(join(dataDir, "state.json"), "utf8");
    expect(raw).not.toContain(TOKEN);
    const state = JSON.parse(raw);
    expect(state.records[0].tokenHashSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.records[0].tokenHashSha256).not.toBe(TOKEN);
  });

  test("is idempotent: a second ensure at the same generation does not call docker run again", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    const first = await provisioner.ensure(baseEnsureRequest());
    const second = await provisioner.ensure(baseEnsureRequest());

    expect(first).toEqual(second);
    expect(commands.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  test("rejects a stale generation without calling docker", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    await provisioner.ensure(baseEnsureRequest({ generation: 3 }));
    const result = await provisioner.ensure(baseEnsureRequest({ generation: 2 }));

    expect(result).toMatchObject({ kind: "rejected", code: "stale_generation" });
    expect(commands.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  test("rejects when docker run exits non-zero", async () => {
    const commands = createFakeCommandRunner(async () => ({
      stdout: "",
      stderr: "Error: no such image",
      exitCode: 125,
    }));
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    const result = await provisioner.ensure(baseEnsureRequest());

    expect(result).toMatchObject({
      kind: "rejected",
      code: "docker_run_failed",
      retryable: true,
    });
  });
});

describe("destroy", () => {
  test("stops and removes the container recorded for the allocation", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });
    await provisioner.ensure(baseEnsureRequest());

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
    });

    expect(result).toEqual({ kind: "destroyed" });
    expect(commands.calls).toContainEqual(["stop", "container-abc"]);
    expect(commands.calls).toContainEqual(["rm", "container-abc"]);
  });

  test("prefers externalRef over the stored containerId when given", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });
    await provisioner.ensure(baseEnsureRequest());

    await provisioner.destroy({
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
      externalRef: "container-xyz",
    });

    expect(commands.calls).toContainEqual(["stop", "container-xyz"]);
    expect(commands.calls).not.toContainEqual(["stop", "container-abc"]);
  });

  test("is idempotent when the container is already gone", async () => {
    const commands = createFakeCommandRunner(async (args) => {
      if (args[0] === "stop" || args[0] === "rm") {
        return { stdout: "", stderr: "Error: No such container", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });

    const result = await provisioner.destroy({
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
      externalRef: "container-gone",
    });

    expect(result).toEqual({ kind: "destroyed" });
  });

  test("fences a stale ensure that arrives after destroy", async () => {
    const commands = ensuredRunner("container-abc");
    const provisioner = createDockerSidecarProvisioner({
      config: { image: IMAGE, stateFilePath: join(dataDir, "state.json") },
      commands,
      store,
    });
    await provisioner.ensure(baseEnsureRequest());
    await provisioner.destroy({
      allocationId: "alloc-1",
      generation: 1,
      sidecarId: "sidecar-1",
    });

    const result = await provisioner.ensure(baseEnsureRequest());

    expect(result).toMatchObject({
      kind: "rejected",
      code: "generation_destroyed",
    });
    expect(commands.calls.filter((call) => call[0] === "run")).toHaveLength(1);
  });
});
