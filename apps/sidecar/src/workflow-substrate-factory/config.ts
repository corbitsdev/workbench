// Substrate-config parsing for the sidecar's workflow-process child:
// the required substrate-config key allowlist, the typed schema the
// factory narrows the config record against, and the per-key parsers
// (byte caps, the per-step inference-source table, and the custom
// inference adapter manifest).

import { type } from "arktype";

import { AdapterManifest } from "@intx/inference";
import { InferenceSource } from "@intx/types/runtime";

/**
 * Required substrate-config keys the sidecar's binary forwards into
 * the factory's `substrateConfig` slot. Listed here so the binary
 * passes the same names to the helper; the helper enforces
 * presence-and-non-empty against this allowlist before the factory
 * runs.
 *
 * `HUB_WS_URL`, `SIDECAR_ID`, and `SIDECAR_TOKEN` carry the
 * hub-connection trust anchors the child needs to ship workflow-run
 * pack pushes back to the hub. The sidecar's deploy router populates
 * these via the supervisor's `substrateEnv` plumbing
 * (`multistepSubstrateEnv` on `createSidecarDeployRouter`), threaded
 * from the boot edge's own env reads.
 */
export const SIDECAR_SUBSTRATE_CONFIG_KEYS = [
  "SIDECAR_DATA_DIR",
  "WORKFLOW_DEFINITION_REPO_ID",
  "WORKFLOW_DEFINITION_REF",
  "WORKFLOW_RUN_REPO_ID",
  "WORKFLOW_RUN_REF",
  "SIDECAR_SIGNING_PUBLIC_KEY",
  "SIDECAR_SIGNING_PRIVATE_KEY",
  "HUB_WS_URL",
  "SIDECAR_ID",
  "SIDECAR_TOKEN",
  "STEP_INFERENCE_SOURCES",
  "SIDECAR_CACHE_MAX_BYTES",
  "SIDECAR_REGISTRY_MAX_TARBALL_BYTES",
  "SIDECAR_ADAPTER_MANIFEST",
  "SIDECAR_TOOL_REGISTRIES",
] as const;

export const SubstrateConfig = type({
  SIDECAR_DATA_DIR: "string > 0",
  WORKFLOW_DEFINITION_REPO_ID: "string > 0",
  WORKFLOW_DEFINITION_REF: "string > 0",
  WORKFLOW_RUN_REPO_ID: "string > 0",
  WORKFLOW_RUN_REF: "string > 0",
  SIDECAR_SIGNING_PUBLIC_KEY: "string > 0",
  SIDECAR_SIGNING_PRIVATE_KEY: "string > 0",
  HUB_WS_URL: "string > 0",
  SIDECAR_ID: "string > 0",
  SIDECAR_TOKEN: "string > 0",
  STEP_INFERENCE_SOURCES: "string > 0",
  // Per-step tool-loader caps. The supervisor threads the boot edge's
  // resolved `SIDECAR_CACHE_MAX_BYTES` / `SIDECAR_REGISTRY_MAX_TARBALL_BYTES`
  // through `substrateEnv` so the child's per-step tool materialization is
  // bounded by the sidecar's boot-edge-resolved caps. Validated as
  // positive-finite-number strings at this boundary.
  SIDECAR_CACHE_MAX_BYTES: "string > 0",
  SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "string > 0",
  // JSON-encoded custom inference adapter manifest. Required: the boot
  // edge always serializes it into `substrateEnv` (defaulting to "[]"
  // when no custom adapters are configured), so a missing key child-side
  // is a serialization bug and must fail loud here, exactly like the
  // byte-cap fields. Validated as a non-empty string at this boundary;
  // its JSON shape is re-validated against `AdapterManifest` in
  // `parseAdapterManifest` before any module is imported.
  SIDECAR_ADAPTER_MANIFEST: "string > 0",
  // JSON-encoded tool-registry list. Required: the boot edge always
  // serializes it (defaulting to the public npmjs registry when the
  // operator pinned none), so a missing key child-side is a
  // serialization bug and must fail loud here. Its JSON shape is
  // re-validated by `parseToolRegistries` before any tool loads —
  // per-step materialization never falls back to a default of its own.
  SIDECAR_TOOL_REGISTRIES: "string > 0",
}).onUndeclaredKey("ignore");

/**
 * Parse a substrate-config cap entry (`SIDECAR_CACHE_MAX_BYTES` /
 * `SIDECAR_REGISTRY_MAX_TARBALL_BYTES`) into a positive finite number.
 * The boot edge already validated these via the `config.ts` readers
 * before serializing them into `substrateEnv`; this re-parse at the
 * child boundary keeps the typed-config contract honest rather than
 * trusting the wire blindly.
 */
export function parseByteCap(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `sidecar workflow-child substrate config: ${name} must be a positive finite number; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Per-step inference-source table parsed from the spawn-time
 * `STEP_INFERENCE_SOURCES` env entry. The deploy router serializes
 * `frame.workflow.sources` (a `Record<stepId, InferenceSource[]>`) as
 * JSON and threads it through the supervisor's `substrateEnv`; the
 * factory parses and validates the table once at construction time and
 * seeds it into the run loop's mutable sources reference, which each
 * `buildEnv` reads. Each value is the step's ordered
 * failover chain -- element 0 is the active source, the tail are the
 * reactor's forward-only failover targets -- so the list is non-empty.
 */
export const StepInferenceSourceTable = type({
  "[string]": InferenceSource.array().atLeastLength(1),
});
export type StepInferenceSourceTable = typeof StepInferenceSourceTable.infer;

/**
 * Parse and validate the JSON-encoded `STEP_INFERENCE_SOURCES` entry
 * the supervisor threaded through `substrateEnv`. A malformed JSON
 * payload, a non-object root, or a value that does not match
 * `Record<string, InferenceSource>` is rejected at the boundary with
 * a structured error rather than being deferred to a deep-stack
 * `buildEnv` failure.
 */
export function parseStepInferenceSources(
  raw: string,
): StepInferenceSourceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar workflow-child substrate config: STEP_INFERENCE_SOURCES is not valid JSON: ${reason}`,
      { cause },
    );
  }
  const validated = StepInferenceSourceTable(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar workflow-child substrate config: STEP_INFERENCE_SOURCES failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

/**
 * Parse and validate the JSON-encoded `SIDECAR_ADAPTER_MANIFEST` entry
 * the supervisor threaded through `substrateEnv` from the boot edge's
 * `readAdapterManifest`.
 *
 * Trust boundary: the child's substrate config is operator-supplied
 * (the supervisor's `Bun.spawn` env), so this re-validation is
 * defense-in-depth at the deserialization boundary, NOT a trust
 * upgrade. The manifest was already trusted operator config on the
 * parent side; the same channel already carries the sidecar's signing
 * private key, so it is not a lower-trust surface. Re-asserting the
 * shape here keeps the typed-config contract honest rather than
 * importing modules off an unvalidated wire value.
 *
 * Host contract for custom adapters: a manifest `specifier` must
 * resolve from BOTH the sidecar's and this child's module-resolution
 * roots (the child is a separate `bun` process spawned by the
 * supervisor), and an adapter module MUST be import-side-effect-free —
 * it is imported once per process by `loadAdapterRegistry`, and any
 * top-level side effect would run independently in the parent and in
 * every child.
 */
export function parseAdapterManifest(raw: string): AdapterManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      "sidecar workflow-child substrate config: SIDECAR_ADAPTER_MANIFEST is not valid JSON",
      { cause },
    );
  }
  const validated = AdapterManifest(parsed);
  if (validated instanceof type.errors) {
    throw new Error(
      `sidecar workflow-child substrate config: SIDECAR_ADAPTER_MANIFEST failed validation: ${validated.summary}`,
    );
  }
  return validated;
}

/**
 * Resolve the per-step inference-source failover chain from the table a
 * build reads. The supervisor's multi-step branch only invokes
 * a step whose `stepId` appears in `frame.workflow.sources`; a lookup
 * miss here is a programmer error in the supervisor, not a wire-side
 * failure, and the resolver surfaces it with the missing `stepId`
 * named. The returned list is the step's ordered chain (element 0 the
 * active source, the tail the reactor's failover targets); the table's
 * arktype guarantees it is non-empty.
 */
/**
 * Derives the hub's plain HTTP origin from its `HUB_WS_URL` trust anchor
 * (`ws://` -> `http://`, `wss://` -> `https://`, same host/port, no
 * path). Used to reach the workflow-artifacts HTTP surface
 * (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, CL-6000)
 * with the same `SIDECAR_TOKEN` the child already carries for pack-push
 * — a second `HUB_HTTP_URL` substrate-config key would just be another
 * name for the same origin the operator already configured once.
 */
export function deriveHubHttpUrl(hubWsUrl: string): string {
  const url = new URL(hubWsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function createStepInferenceSourceResolver(
  table: StepInferenceSourceTable,
): (stepId: string) => InferenceSource[] {
  return (stepId: string): InferenceSource[] => {
    const sources = table[stepId];
    if (sources === undefined) {
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: no InferenceSource pinned for stepId ${JSON.stringify(stepId)}; the supervisor must populate frame.workflow.sources for every stepOrder entry`,
      );
    }
    return sources;
  };
}
