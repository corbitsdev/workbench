// The E2B specifics originated from the private repo
// faremeter/interchange-e2b-provisioner (github.com/faremeter/interchange-e2b-provisioner)
// at commit c1e3182. We now own this code; it is not a vendored path.
//
// Implements @corbits/sandbox-sidecar's SidecarBackend port against the E2B
// SDK: which SDK calls map to start/stop/find, sandbox metadata handling,
// and error classification (retryable vs terminal). Generation fencing,
// the allocation state store, and obsolete-unit sweeping all now live in
// the shared core — this file only ever talks to E2B.
import {
  AuthenticationError,
  InvalidArgumentError,
  RateLimitError,
  Sandbox,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";

import {
  BackendOperationError,
  type SidecarBackend,
  type StartUnitArgs,
} from "@corbits/sandbox-sidecar";

import type { ProvisionerConfig } from "./config";

const PROVISIONER_MARKER = "interchange-e2b-v1";
const LAUNCHER_COMMAND = "bun run /opt/interchange-e2b/start-sidecar.ts";

export type SandboxOperationFailure = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
};

export function createE2BBackend(config: ProvisionerConfig): SidecarBackend {
  const connection = {
    apiKey: config.apiKey,
    requestTimeoutMs: config.requestTimeoutMs,
  };

  async function listAllocationSandboxIds(
    allocationId: string,
  ): Promise<readonly string[]> {
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
  return new BackendOperationError(
    classified.code,
    classified.message,
    classified.retryable,
  );
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
