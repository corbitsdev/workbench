// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.
import { isAbsolute } from "node:path";

import {
  AuthenticationError,
  InvalidArgumentError,
  RateLimitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";
import { type } from "arktype";

import {
  BackendOperationError,
  createAllocationStateStore,
  createSidecarProvisioner as createCoreSidecarProvisioner,
  sidecarCapabilityDeclarations,
  type AllocationStateStore,
  type SidecarBackend,
  type StartUnitArgs,
} from "./sandbox-sidecar";
import type { SidecarProvisioner } from "@intx/hub-sessions";

const Environment = type({
  E2B_API_KEY: "string > 0",
  E2B_TEMPLATE: "string > 0",
  "E2B_SANDBOX_TIMEOUT_MS?": "string",
});

export type ProvisionerConfig = {
  readonly apiKey: string;
  readonly template: string;
  readonly dataDir: string;
  readonly sandboxTimeoutMs: number;
  readonly requestTimeoutMs: number;
};

/**
 * `dataDir` is the HUB's own state directory for this backend -- where the
 * allocation fences, destroy tombstones, and sandbox refs live -- not the
 * sandbox's `SIDECAR_DATA_DIR`. The hub derives it from its data dir the
 * same way it does for the container backend, so it is a caller argument
 * rather than an environment variable an operator could point somewhere
 * unrelated.
 */
export function readProvisionerConfig(
  env: Record<string, string | undefined>,
  dataDir: string,
): ProvisionerConfig {
  const parsed = Environment(env);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid E2B provisioner configuration: ${parsed.summary}`);
  }
  if (!parsed.E2B_API_KEY.startsWith("e2b_") || parsed.E2B_API_KEY.length < 16) {
    throw new Error("E2B_API_KEY must be a valid E2B API key");
  }
  if (!isAbsolute(dataDir)) {
    throw new Error("E2B provisioner data dir must be an absolute path");
  }

  const sandboxTimeoutMs = readTimeout(parsed.E2B_SANDBOX_TIMEOUT_MS, 15 * 60 * 1_000);
  return {
    apiKey: parsed.E2B_API_KEY,
    template: parsed.E2B_TEMPLATE,
    dataDir,
    sandboxTimeoutMs,
    requestTimeoutMs: 60_000,
  };
}
function readTimeout(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000) {
    throw new Error("E2B_SANDBOX_TIMEOUT_MS must be at least 60000");
  }
  if (timeoutMs > 24 * 60 * 60 * 1_000) {
    throw new Error("E2B_SANDBOX_TIMEOUT_MS cannot exceed 24 hours");
  }
  return timeoutMs;
}

const PROVISIONER_MARKER = "interchange-e2b-v1";
const LAUNCHER_COMMAND = "bun run /opt/interchange-e2b/start-sidecar.ts";

export type SandboxOperationFailure = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

/**
 * Implements `./sandbox-sidecar`'s SidecarBackend port against the E2B
 * SDK: which SDK calls map to start/stop/find, sandbox metadata handling,
 * and error classification (retryable vs terminal). Generation fencing,
 * the allocation state store, and obsolete-unit sweeping all come from
 * the shared core — this only ever talks to E2B.
 */
export function createE2BBackend(config: ProvisionerConfig): SidecarBackend {
  const connection = {
    apiKey: config.apiKey,
    requestTimeoutMs: config.requestTimeoutMs,
  };

  async function listAllocationSandboxIds(allocationId: string): Promise<readonly string[]> {
    const paginator = Sandbox.list({
      ...connection,
      query: {
        metadata: {
          intx_provisioner: PROVISIONER_MARKER,
          intx_allocation_id: allocationId,
        },
        state: ["running", "paused"],
      },
    });
    const sandboxIds: string[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems(connection);
      for (const sandbox of page) {
        sandboxIds.push(sandbox.sandboxId);
      }
    }
    return sandboxIds;
  }

  return {
    async startUnit(args: StartUnitArgs): Promise<string> {
      try {
        const sandbox = await Sandbox.create(config.template, {
          ...connection,
          timeoutMs: config.sandboxTimeoutMs,
          lifecycle: { onTimeout: "kill", autoResume: false },
          allowInternetAccess: true,
          metadata: {
            intx_provisioner: PROVISIONER_MARKER,
            intx_allocation_id: args.allocationId,
            intx_sidecar_id: args.sidecarId,
            intx_generation: String(args.generation),
          },
        });
        await sandbox.commands.run(LAUNCHER_COMMAND, {
          background: true,
          cwd: "/repo",
          // E2B otherwise applies its 60-second command default even to a
          // background process. Keep the sidecar alive for the sandbox's
          // configured allocation lifetime; the sandbox timeout remains
          // the outer cleanup bound.
          timeoutMs: config.sandboxTimeoutMs,
          envs: {
            // KNOWN CAVEAT: the sidecar allocation token reaches the
            // sandbox through a plain environment variable. E2B has no
            // narrower secret-injection primitive for background
            // commands today; this is an accepted, unmitigated exposure
            // surface.
            HUB_WS_URL: args.hubWebSocketUrl,
            SIDECAR_ID: args.sidecarId,
            SIDECAR_TOKEN: args.token,
            SIDECAR_DATA_DIR: "/home/user/interchange-sidecar-data",
            NODE_ENV: "production",
          },
        });
        return sandbox.sandboxId;
      } catch (error) {
        throw toBackendOperationError(error);
      }
    },

    async stopUnit(externalRef: string): Promise<void> {
      try {
        await Sandbox.kill(externalRef, connection);
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return;
        throw toBackendOperationError(error);
      }
    },

    async findUnitsByAllocation(allocationId: string) {
      try {
        return await listAllocationSandboxIds(allocationId);
      } catch (error) {
        throw toBackendOperationError(error);
      }
    },
  };
}

function toBackendOperationError(error: unknown): BackendOperationError {
  const classified = classifyE2BError(error);
  return new BackendOperationError(classified.code, classified.message, classified.retryable);
}

export function classifyE2BError(error: unknown): SandboxOperationFailure {
  if (error instanceof AuthenticationError) {
    return {
      code: "e2b_authentication_failed",
      message: "E2B rejected the provisioner credentials",
      retryable: false,
    };
  }
  if (error instanceof InvalidArgumentError) {
    return {
      code: "e2b_invalid_request",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof RateLimitError) {
    return {
      code: "e2b_rate_limited",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof TimeoutError) {
    return {
      code: "e2b_timeout",
      message: error.message,
      retryable: true,
    };
  }
  if (error instanceof SandboxNotFoundError) {
    return {
      code: "sandbox_not_found",
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: "e2b_operation_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

const PROVISIONER_API_VERSION = 1 as const;

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
    opts.config ?? readProvisionerConfig(opts.env ?? process.env, requireDataDir(opts.dataDir));
  return createCoreSidecarProvisioner({
    id: "e2b",
    apiVersion: PROVISIONER_API_VERSION,
    bindingFingerprint: `e2b:v1:${config.template}`,
    // Declares nothing, so this provisioner serves any deployment that
    // states no capability requirement — the behaviour it had before
    // Interchange replaced sidecar placement with capability selection.
    capabilities: sidecarCapabilityDeclarations("vm"),
    backend: createE2BBackend(config),
    store: opts.store ?? createAllocationStateStore(`${config.dataDir}/state.json`),
  });
}
