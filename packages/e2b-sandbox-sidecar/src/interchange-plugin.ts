import {
  createAllocationStateStore,
  createSidecarProvisioner as createCoreSidecarProvisioner,
  type AllocationStateStore,
} from "@corbits/sandbox-sidecar";
import type { SidecarProvisioner } from "@intx/hub-sessions";

import type { ProvisionerConfig } from "./config";
import { readProvisionerConfig } from "./config";
import { createE2BBackend } from "./e2b-backend";

const PROVISIONER_API_VERSION: 1 = 1;

function requireDataDir(dataDir: string | undefined): string {
  if (dataDir === undefined) {
    throw new Error(
      "createSidecarProvisioner requires dataDir (the hub's state directory for this backend) when no config is supplied",
    );
  }
  return dataDir;
}

export type CreateSidecarProvisionerOpts = {
  readonly env?: Record<string, string | undefined>;
  /** Hub-side state directory for this backend's allocation fences. */
  readonly dataDir?: string;
  readonly config?: ProvisionerConfig;
  readonly store?: AllocationStateStore;
};

export function createSidecarProvisioner(
  opts: CreateSidecarProvisionerOpts = {},
): SidecarProvisioner {
  const config =
    opts.config ??
    readProvisionerConfig(
      opts.env ?? process.env,
      requireDataDir(opts.dataDir),
    );
  return createCoreSidecarProvisioner({
    id: "e2b",
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `e2b:v1:${config.template}`,
    backend: createE2BBackend(config),
    store:
      opts.store ?? createAllocationStateStore(`${config.dataDir}/state.json`),
  });
}
