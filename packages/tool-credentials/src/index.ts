// Credential rail for in-sidecar native tool packages: a credentialed
// factory declares `requires: [toolCredentialEnvKey(p)]` and reads the key
// via `getToolCredential(env, p)`; the sidecar injects it from the hub.
// Kept off `credentialRequirements` (which is inference-only).
// See docs/CREATING_AGENTS_AND_TOOLS.md.

import { type } from "arktype";

/** Env-key prefix for an injected tool credential, namespaced by provider. */
export const TOOL_CREDENTIAL_ENV_PREFIX = "workbench.cred.";

/** Build the env key / `requires` entry for a provider's credential. */
export function toolCredentialEnvKey(providerName: string): string {
  return `${TOOL_CREDENTIAL_ENV_PREFIX}${providerName}`;
}

/** If `key` is a tool-credential env key, return the provider name it carries. */
export function providerFromEnvKey(key: string): string | undefined {
  if (!key.startsWith(TOOL_CREDENTIAL_ENV_PREFIX)) return undefined;
  const provider = key.slice(TOOL_CREDENTIAL_ENV_PREFIX.length);
  return provider.length > 0 ? provider : undefined;
}

/** A resolved provider credential delivered to an in-sidecar tool. */
export const ToolCredential = type({
  apiKey: "string",
  baseURL: "string",
});
export type ToolCredential = typeof ToolCredential.infer;

/** Request body for the hub's tool-credential resolution endpoint. */
export const ToolCredentialsRequest = type({
  tenantId: "string",
  agentId: "string",
  providerNames: "string[]",
});
export type ToolCredentialsRequest = typeof ToolCredentialsRequest.infer;

/** Response body: resolved credentials keyed by provider name. */
export const ToolCredentialsResponse = type({
  credentials: type.Record("string", ToolCredential),
});
export type ToolCredentialsResponse = typeof ToolCredentialsResponse.infer;

// ─── Tool-package manifest rail (workflow steps) ───────────────────────
//
// A live agent receives its tool-package tarballs via the per-agent deploy
// pack fan-out at `SessionService.launchSession`. A workflow STEP agent
// runs in the shared `bin/workflow-child` and bypasses launchSession, so
// it has no deploy pack on disk. This rail lets the step's in-process
// harness fetch the same tenant-scoped, resolved manifest plus the raw
// tarball bytes the live path materializes — over the hub's authenticated
// channel, gated identically (by the step's persisted `agent` row pins).

/** Request body for the hub's tool-package manifest+tarball resolution. */
export const ToolManifestRequest = type({
  tenantId: "string",
  agentId: "string",
});
export type ToolManifestRequest = typeof ToolManifestRequest.infer;

/** One materialized tarball: the asset mount + asset-relative path + bytes. */
export const ToolManifestTarball = type({
  assetId: "string",
  /** assetRoot-relative mount dir, e.g. `package-registries/<name>/`. */
  mount: "string",
  /** mount-relative tarball path, e.g. `tarballs/<file>.tgz`. */
  path: "string",
  /** Base64-encoded tarball bytes. */
  bytesBase64: "string",
});
export type ToolManifestTarball = typeof ToolManifestTarball.infer;

/**
 * Response body: the resolved `ToolPackageManifest` (as opaque JSON the
 * sidecar re-validates against `@intx/types/tool-packages`) plus every
 * asset-sourced tarball the manifest references, with the mount each
 * `assetId` should be written under so the sidecar loader's `assetMounts`
 * map can be reconstructed.
 */
export const ToolManifestResponse = type({
  manifest: "unknown",
  tarballs: ToolManifestTarball.array(),
});
export type ToolManifestResponse = typeof ToolManifestResponse.infer;

/**
 * Read a resolved tool credential from the agent env. Throws if the host
 * did not inject it — a credentialed factory that declared the matching
 * `requires` entry should always find it, so a miss is a wiring fault
 * worth surfacing loudly rather than degrading to an unauthenticated call.
 */
export function getToolCredential(
  env: Record<string, unknown>,
  providerName: string,
): ToolCredential {
  const value = env[toolCredentialEnvKey(providerName)];
  const parsed = ToolCredential(value);
  if (parsed instanceof type.errors) {
    throw new Error(
      `tool credential for provider "${providerName}" was not injected into env: ${parsed.summary}`,
    );
  }
  return parsed;
}

// ─── Live-deployments rail (boot reconciler) ──────────────────────────
//
// On a sidecar restart, orphaned on-disk dirs from deployments the hub has
// since soft-deleted/superseded are otherwise re-established by
// interchange's `restoreSessions()`. The boot reconciler prunes them
// BEFORE the orchestrator connects. To do so fail-safely it must know the
// positively-confirmed LIVE deployment set; the hub serves it over the
// same sidecar-token channel the tool rails use. The hub is the source of
// truth and is never mutated by the reconciler — this is a read-only set.

/**
 * One live deployment's on-disk footprint, as the hub derives it from a
 * `workflow_run` row with `deletedAt IS NULL`. The reconciler maps each
 * field to the exact sidecar dir name it must KEEP:
 *
 * - `supervisorAddress` / `stepAddresses` -> top-level agent dirs
 *   (`<dataDir>/<sanitizeAddress(address)>/`).
 * - `workflowRunSlug` -> `<dataDir>/workflow-runs/<slug>/`.
 * - `agentStateRepoIds` -> `<dataDir>/agents/<id>/`.
 *
 * `supervisorAgentId` and `stepAgentIds` are carried for completeness /
 * diagnostics (they are the `agent` row ids, not dir names).
 */
export const LiveDeployment = type({
  deploymentId: "string",
  supervisorAddress: "string",
  supervisorAgentId: "string",
  workflowRunSlug: "string",
  stepAgentIds: "string[]",
  stepAddresses: "string[]",
  agentStateRepoIds: "string[]",
});
export type LiveDeployment = typeof LiveDeployment.infer;

/** Response body: the positively-confirmed live deployment set. */
export const LiveDeploymentsResponse = type({
  deployments: LiveDeployment.array(),
  // CL-2248: deployment ids that still have at least one in-flight
  // (`running`/`awaiting`) workflow_run_record. A subset of `deployments`.
  // The boot reconciler prunes dirs for any live deployment NOT in this set
  // (its runs are all terminal), so step session dirs of restart-failed runs
  // are removed and restoreSessions() can't re-provision the dead session.
  activeRunDeploymentIds: "string[]",
  // CL-2264: every agentInstance.address where endedAt IS NULL. The boot
  // reconciler uses this to reap on-disk agent dirs whose hub row is gone,
  // rather than letting them restore + crash-loop on every boot.
  liveAgentAddresses: "string[]",
});
export type LiveDeploymentsResponse = typeof LiveDeploymentsResponse.infer;

// ─── Hub-RPC rail ──────────────────────────────────────────────────────
//
// Hub-backed tools (artifact/dispatch/list_agents) run in the sidecar but
// execute against the hub db. They reach the hub the same documented way
// the sidecar already does: the shared sidecar token over TLS plus the
// agent's identity, with the hub authorizing each call against the
// instance principal's grants. The sidecar injects this context into env
// under `HUB_RPC_ENV_KEY`; a hub-backed package declares it via `requires`.

/** Env key carrying the hub-RPC context for hub-backed tool packages. */
export const HUB_RPC_ENV_KEY = "workbench.hubRpc";

export const HubRpcContext = type({
  baseURL: "string",
  token: "string",
  tenantId: "string",
  agentId: "string",
  principalId: "string",
  sessionId: "string",
});
export type HubRpcContext = typeof HubRpcContext.infer;

/** Read the hub-RPC context the sidecar injected. Throws if absent. */
export function getHubRpc(env: Record<string, unknown>): HubRpcContext {
  const parsed = HubRpcContext(env[HUB_RPC_ENV_KEY]);
  if (parsed instanceof type.errors) {
    throw new Error(
      `hub-RPC context was not injected into env: ${parsed.summary}`,
    );
  }
  return parsed;
}
