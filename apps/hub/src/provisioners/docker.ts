import { resolve } from "node:path";

import { type } from "arktype";

import {
  BackendOperationError,
  createAllocationStateStore,
  createSidecarProvisioner,
  sidecarCapabilityDeclarations,
  type AllocationStateStore,
  type SidecarBackend,
  type StartUnitArgs,
} from "./sandbox-sidecar";
import type { SidecarProvisioner } from "@intx/hub-sessions";

const Environment = type({
  DOCKER_PROVISIONER_IMAGE: "string > 0",
  "DOCKER_PROVISIONER_DATA_DIR?": "string > 0",
});

const DEFAULT_DATA_DIR = ".data/docker-provisioner";

export type DockerProvisionerConfig = {
  readonly image: string;
  readonly stateFilePath: string;
};

/**
 * Parse the docker provisioner's configuration out of an environment map.
 * Throws at the call site, listing every problem at once, so a
 * misconfigured process dies at boot instead of failing at first use.
 */
export function readDockerProvisionerConfig(
  env: Record<string, string | undefined>,
): DockerProvisionerConfig {
  const parsed = Environment(env);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid docker provisioner environment: ${parsed.summary}`);
  }
  const dataDir = resolve(parsed.DOCKER_PROVISIONER_DATA_DIR ?? DEFAULT_DATA_DIR);
  return {
    image: parsed.DOCKER_PROVISIONER_IMAGE,
    stateFilePath: resolve(dataDir, "state.json"),
  };
}

export type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

export interface CommandRunner {
  run(args: readonly string[]): Promise<CommandResult>;
}

export function createBunCommandRunner(): CommandRunner {
  return {
    async run(args) {
      const child = Bun.spawn(["docker", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}

const ALLOCATION_ID_LABEL = "corbits.allocationId";
const SIDECAR_ID_LABEL = "corbits.sidecarId";

// The path @workbench/sidecar's own boot config expects SIDECAR_DATA_DIR
// to resolve inside the container filesystem — see apps/sidecar/src/
// config.ts. It is not host-configurable: unlike DOCKER_PROVISIONER_DATA_DIR
// (this provisioner's own state file, on the host), this is a path inside
// every sidecar container's own filesystem, so one fixed value is correct
// for every allocation.
const CONTAINER_SIDECAR_DATA_DIR = "/home/sidecar/interchange-sidecar-data";

/**
 * Implements `./sandbox-sidecar`'s SidecarBackend port against the local
 * `docker` CLI: `docker run` starts a unit, `docker stop`/`docker rm`
 * remove one, and `docker ps` filtered by allocation label finds existing
 * units. All docker-specific knowledge (labels, env vars, the image)
 * lives here; the shared core never sees a docker command.
 */
export function createDockerBackend(
  commands: CommandRunner,
  config: DockerProvisionerConfig,
): SidecarBackend {
  return {
    async startUnit(args: StartUnitArgs): Promise<string> {
      const result = await commands.run([
        "run",
        "-d",
        "--label",
        `${ALLOCATION_ID_LABEL}=${args.allocationId}`,
        "--label",
        `${SIDECAR_ID_LABEL}=${args.sidecarId}`,
        "-e",
        `HUB_WS_URL=${args.hubWebSocketUrl}`,
        "-e",
        `SIDECAR_TOKEN=${args.token}`,
        "-e",
        `SIDECAR_ID=${args.sidecarId}`,
        "-e",
        `SIDECAR_DATA_DIR=${CONTAINER_SIDECAR_DATA_DIR}`,
        config.image,
      ]);
      if (result.exitCode !== 0) {
        throw new BackendOperationError(
          "docker_run_failed",
          `docker run exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
          true,
        );
      }
      return result.stdout.trim();
    },

    async stopUnit(externalRef: string): Promise<void> {
      const failure = await removeContainer(commands, externalRef);
      if (failure !== null) {
        throw new BackendOperationError("docker_destroy_failed", failure, true);
      }
    },

    async findUnitsByAllocation(allocationId: string): Promise<readonly string[]> {
      const result = await commands.run([
        "ps",
        "-aq",
        "--filter",
        `label=${ALLOCATION_ID_LABEL}=${allocationId}`,
      ]);
      if (result.exitCode !== 0) return [];
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
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

const PROVISIONER_API_VERSION = 1 as const;

export type CreateDockerSidecarProvisionerOpts = {
  readonly env?: Record<string, string | undefined>;
  readonly config?: DockerProvisionerConfig;
  readonly commands?: CommandRunner;
  readonly store?: AllocationStateStore;
};

export function createDockerSidecarProvisioner(
  opts: CreateDockerSidecarProvisionerOpts = {},
): SidecarProvisioner {
  const config = opts.config ?? readDockerProvisionerConfig(opts.env ?? process.env);
  const commands = opts.commands ?? createBunCommandRunner();
  const store = opts.store ?? createAllocationStateStore(config.stateFilePath);

  return createSidecarProvisioner({
    id: "docker",
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `docker:v1:${config.image}`,
    // Declares nothing, so this provisioner serves any deployment that
    // states no capability requirement — the behaviour it had before
    // Interchange replaced sidecar placement with capability selection.
    capabilities: sidecarCapabilityDeclarations("container"),
    backend: createDockerBackend(commands, config),
    store,
  });
}
