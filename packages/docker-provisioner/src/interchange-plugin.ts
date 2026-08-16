import { sha256 } from "@intx/crypto";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";

import { createBunCommandRunner, type CommandRunner } from "./command-runner";
import { readDockerProvisionerConfig, type DockerProvisionerConfig } from "./config";
import { createAllocationStateStore, type AllocationStateStore } from "./state-store";

const PROVISIONER_API_VERSION: 1 = 1;

const ALLOCATION_ID_LABEL = "corbits.allocationId";
const SIDECAR_ID_LABEL = "corbits.sidecarId";

export type CreateDockerSidecarProvisionerOpts = {
  readonly env?: Record<string, string | undefined>;
  readonly config?: DockerProvisionerConfig;
  readonly commands?: CommandRunner;
  readonly store?: AllocationStateStore;
};

export function createDockerSidecarProvisioner(
  opts: CreateDockerSidecarProvisionerOpts = {},
): SidecarProvisioner {
  const config =
    opts.config ?? readDockerProvisionerConfig(opts.env ?? process.env);
  const commands = opts.commands ?? createBunCommandRunner();
  const store = opts.store ?? createAllocationStateStore(config.stateFilePath);

  return {
    id: "docker",
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `docker:v1:${config.image}`,

    async ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
      const validation = validateEnsureRequest(request);
      if (validation !== null) {
        return rejected("invalid_ensure_request", validation, false);
      }

      const observation = await store.observeEnsure({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
      });
      if (observation.kind === "rejected") {
        return rejected(observation.code, observation.message, false);
      }
      if (observation.record.containerId !== null) {
        return { kind: "accepted", externalRef: observation.record.containerId };
      }

      const tokenHashSha256 = await hashToken(request.token);
      const result = await commands.run([
        "run",
        "-d",
        "--label",
        `${ALLOCATION_ID_LABEL}=${request.allocationId}`,
        "--label",
        `${SIDECAR_ID_LABEL}=${request.sidecarId}`,
        "-e",
        `HUB_WS_URL=${request.hubWebSocketUrl}`,
        "-e",
        `SIDECAR_TOKEN=${request.token}`,
        config.image,
      ]);
      if (result.exitCode !== 0) {
        return rejected(
          "docker_run_failed",
          `docker run exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
          true,
        );
      }
      const containerId = result.stdout.trim();

      const recorded = await store.recordContainer({
        allocationId: request.allocationId,
        generation: request.generation,
        containerId,
        tokenHashSha256,
      });
      if (!recorded) {
        await removeContainer(commands, containerId);
        return rejected(
          "stale_generation",
          `Generation ${String(request.generation)} was superseded while the docker run was in flight`,
          false,
        );
      }
      return { kind: "accepted", externalRef: containerId };
    },

    async destroy(
      request: DestroySidecarRequest,
    ): Promise<DestroySidecarResult> {
      const validation = validateDestroyRequest(request);
      if (validation !== null) {
        return rejected("invalid_destroy_request", validation, false);
      }

      const observation = await store.observeDestroy({
        allocationId: request.allocationId,
        sidecarId: request.sidecarId,
        generation: request.generation,
      });
      if (observation.kind === "rejected") {
        return rejected(observation.code, observation.message, false);
      }

      const containerIds = new Set<string>();
      if (request.externalRef !== undefined) {
        containerIds.add(request.externalRef);
      } else if (observation.record.containerId !== null) {
        containerIds.add(observation.record.containerId);
      } else {
        for (const containerId of await findContainersByLabel(
          commands,
          request.allocationId,
          request.sidecarId,
        )) {
          containerIds.add(containerId);
        }
      }

      for (const containerId of containerIds) {
        const failure = await removeContainer(commands, containerId);
        if (failure !== null) {
          return rejected("docker_destroy_failed", failure, true);
        }
      }
      return { kind: "destroyed" };
    },
  };
}

/**
 * Stops and removes a container, treating "already gone" as success so
 * destroy() stays idempotent. Returns a diagnostic message for any other
 * docker failure instead of silently reporting destruction.
 */
async function removeContainer(
  commands: CommandRunner,
  containerId: string,
): Promise<string | null> {
  const stop = await commands.run(["stop", containerId]);
  if (stop.exitCode !== 0 && !isMissingContainerError(stop.stderr)) {
    return `docker stop exited with code ${String(stop.exitCode)}: ${stop.stderr.trim()}`;
  }
  const remove = await commands.run(["rm", containerId]);
  if (remove.exitCode !== 0 && !isMissingContainerError(remove.stderr)) {
    return `docker rm exited with code ${String(remove.exitCode)}: ${remove.stderr.trim()}`;
  }
  return null;
}

function isMissingContainerError(stderr: string): boolean {
  return stderr.toLowerCase().includes("no such container");
}

async function findContainersByLabel(
  commands: CommandRunner,
  allocationId: string,
  sidecarId: string,
): Promise<readonly string[]> {
  const result = await commands.run([
    "ps",
    "-aq",
    "--filter",
    `label=${ALLOCATION_ID_LABEL}=${allocationId}`,
    "--filter",
    `label=${SIDECAR_ID_LABEL}=${sidecarId}`,
  ]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function hashToken(token: string): Promise<string> {
  const digest = await sha256(token);
  return Buffer.from(digest).toString("hex");
}

function validateEnsureRequest(request: EnsureSidecarRequest): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (request.token === "") return "token must not be empty";
  if (request.hubWebSocketUrl === "") return "hubWebSocketUrl must not be empty";
  if (!Number.isInteger(request.generation) || request.generation <= 0) {
    return "generation must be a positive integer";
  }
  return null;
}

function validateDestroyRequest(
  request: DestroySidecarRequest,
): string | null {
  if (request.allocationId === "") return "allocationId must not be empty";
  if (request.sidecarId === "") return "sidecarId must not be empty";
  if (!Number.isInteger(request.generation) || request.generation <= 0) {
    return "generation must be a positive integer";
  }
  return null;
}

function rejected(code: string, message: string, retryable: boolean) {
  return { kind: "rejected" as const, code, message, retryable };
}
