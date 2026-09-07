import {
  createAllocationStateStore,
  createSidecarProvisioner,
  sidecarCapabilityDeclarations,
  type AllocationStateStore,
} from "@corbits/sandbox-sidecar";
import type { SidecarProvisioner } from "@intx/hub-sessions";

import { createBunCommandRunner, type CommandRunner } from "./command-runner";
import {
  readDockerProvisionerConfig,
  type DockerProvisionerConfig,
} from "./config";
import { createDockerBackend } from "./docker-backend";

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
  const config =
    opts.config ?? readDockerProvisionerConfig(opts.env ?? process.env);
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
