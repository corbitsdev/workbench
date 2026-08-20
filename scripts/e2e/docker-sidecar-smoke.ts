// CL-6096: drives the real @corbits/docker-provisioner plugin against a
// live Docker daemon — create -> exclusive-run (container appears) ->
// release -> container gone. This is the one proof of the docker sidecar
// provisioner that needs real infrastructure, so it lives outside `bun
// test`: it never runs in CI, and it exits 0 with a skip message rather
// than failing when no daemon is reachable, so a fresh checkout without
// Docker installed stays green everywhere else.
//
// Run manually: `bun run scripts/e2e/docker-sidecar-smoke.ts`
// Point it at a real sidecar image with DOCKER_PROVISIONER_IMAGE (the
// same variable the hub reads); it otherwise runs a throwaway public
// image that never connects to a hub — this proof only exercises the
// provisioner's container lifecycle, not a real sidecar boot.
//
// Set DOCKER_SIDECAR_IMAGE to opt into real-image mode: the smoke test
// runs that image instead of the throwaway alpine default, and adds a
// liveness assertion — the container must still be running after
// DOCKER_SIDECAR_SMOKE_STAY_UP_SECONDS (default 5) — to catch a real
// sidecar image that boots and then immediately crash-loops. Default
// alpine lifecycle mode is unchanged: no liveness wait is added there.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDockerSidecarProvisioner } from "../../packages/docker-provisioner/src/index";

const DEFAULT_IMAGE = "docker.io/library/alpine:3.19";
const LOG_PREFIX = "[docker-sidecar-smoke]";

async function dockerAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["docker", "version", "--format", "{{.Server.Version}}"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function containerLabeled(
  allocationId: string,
  sidecarId: string,
  extraFilters: readonly string[] = [],
): Promise<boolean> {
  const proc = Bun.spawn(
    [
      "docker",
      "ps",
      "-aq",
      "--filter",
      `label=corbits.allocationId=${allocationId}`,
      "--filter",
      `label=corbits.sidecarId=${sidecarId}`,
      ...extraFilters,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout.trim().length > 0;
}

async function containerRunning(
  allocationId: string,
  sidecarId: string,
): Promise<boolean> {
  return containerLabeled(allocationId, sidecarId, [
    "--filter",
    "status=running",
  ]);
}

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.log(
      `${LOG_PREFIX} docker not available — skipping. Install/start Docker ` +
        "(or point $DOCKER_HOST at a reachable daemon) to run this proof.",
    );
    return;
  }

  const realImage = process.env["DOCKER_SIDECAR_IMAGE"];
  const image =
    realImage ??
    process.env["DOCKER_SIDECAR_SMOKE_IMAGE"] ??
    process.env["DOCKER_PROVISIONER_IMAGE"] ??
    DEFAULT_IMAGE;
  const stateDir = await mkdtemp(path.join(tmpdir(), "docker-sidecar-smoke-"));
  const provisioner = createDockerSidecarProvisioner({
    config: { image, stateFilePath: path.join(stateDir, "state.json") },
  });

  const allocationId = `alloc_smoke_${randomUUID()}`;
  const sidecarId = `sc_smoke_${randomUUID()}`;
  const request = {
    allocationId,
    generation: 1,
    tenantId: "tnt_smoke",
    anchorRunId: "run_smoke",
    sidecarId,
    token: randomUUID(),
    // Unreachable on purpose: this proof only exercises the container
    // lifecycle, not a real sidecar connecting back to a hub.
    hubWebSocketUrl: "ws://127.0.0.1:1/api/sidecars/ws",
  };

  try {
    console.log(
      `${LOG_PREFIX} create: requesting a sidecar container from ${image}`,
    );
    const ensureResult = await provisioner.ensure(request);
    if (ensureResult.kind !== "accepted") {
      throw new Error(
        `ensure was rejected: ${ensureResult.code}: ${ensureResult.message}`,
      );
    }
    console.log(
      `${LOG_PREFIX} exclusive-run: accepted, externalRef=${ensureResult.externalRef ?? "(none)"}`,
    );

    if (!(await containerLabeled(allocationId, sidecarId))) {
      throw new Error(
        "container-appears check failed: no container found with the allocationId/sidecarId labels",
      );
    }
    console.log(`${LOG_PREFIX} container-appears: confirmed via docker ps -a`);

    if (realImage !== undefined) {
      const stayUpSeconds = Number(
        process.env["DOCKER_SIDECAR_SMOKE_STAY_UP_SECONDS"] ?? "5",
      );
      console.log(
        `${LOG_PREFIX} real-image mode: asserting the container stays up for ${String(stayUpSeconds)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, stayUpSeconds * 1000));
      if (!(await containerRunning(allocationId, sidecarId))) {
        throw new Error(
          `real-image liveness check failed: container exited before ${String(stayUpSeconds)}s elapsed`,
        );
      }
      console.log(
        `${LOG_PREFIX} real-image: container still running after ${String(stayUpSeconds)}s`,
      );
    }

    const destroyResult = await provisioner.destroy({
      allocationId,
      generation: request.generation,
      sidecarId,
      ...(ensureResult.externalRef !== undefined
        ? { externalRef: ensureResult.externalRef }
        : {}),
    });
    if (destroyResult.kind !== "destroyed") {
      throw new Error(
        `release failed: ${destroyResult.code}: ${destroyResult.message}`,
      );
    }
    console.log(`${LOG_PREFIX} release: destroy() reported destroyed`);

    if (await containerLabeled(allocationId, sidecarId)) {
      throw new Error(
        "container-gone check failed: a container with these labels is still present",
      );
    }
    console.log(
      `${LOG_PREFIX} container-gone: confirmed — full lifecycle proof passed`,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `${LOG_PREFIX} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
