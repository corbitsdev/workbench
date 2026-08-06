// Wire-boundary validation and content hashing for the deploy
// router: projection validation of the wire-projected workflow
// definition and the canonical-JSON content hash the supervisor and
// the workflow-process child consume as the deployment's
// content-addressed handle.

import { hexEncode } from "@intx/types";
import { STEP_ID_PATTERN } from "@intx/workflow";

/**
 * Validate the wire-projected workflow definition at the deploy-router
 * boundary. The arktype `AgentDeployFrame` validator enforces the
 * wire shape (`id` is non-empty, `stepOrder` is `string[]`, `steps`
 * is an object, `sources` covers every `stepOrder` entry); this
 * function takes `unknown`-typed inputs so it can also gate callers
 * that bypass the wire boundary, and it enforces the invariants the
 * router and the downstream supervisor rely on:
 *
 *   - `definition.id` is a non-empty string. The arktype shape
 *     already enforces this on the wire; the re-check here protects
 *     bypass callers and keeps the failure shape consistent with the
 *     other invariants this function owns.
 *   - `definition.stepOrder` is non-empty. The wire shape admits
 *     `[]`; a zero-step workflow has no semantics here.
 *   - Every `stepOrder` entry matches `STEP_ID_PATTERN` so per-step
 *     mail-address derivation never needs escaping at the substrate
 *     boundary.
 *   - Every `stepOrder` entry has a corresponding `steps[id]` entry.
 *     The wire shape lets `steps[id]` be `unknown` and lets the
 *     entry be absent; presence is required so the workflow-process
 *     child can resolve each step's primitive at run time.
 *   - Every `stepOrder` entry has a corresponding `sources[id]`
 *     entry, and that entry is a non-empty array (the step's ordered
 *     failover chain). The arktype narrow already enforces both; the
 *     re-check here surfaces a structured router-side error instead of
 *     an arktype validation failure at the wire boundary, which keeps
 *     the failure shape consistent with the rest of the validations
 *     this function owns. An empty chain would leave the reactor with
 *     no initial source, so it is rejected here rather than deferred to
 *     a deep-stack child failure.
 *
 * A rejection here surfaces as a thrown `Error` the link's deploy
 * frame caller converts into a structured failure reply.
 */
export function validateWorkflowProjection(projection: {
  definition: { id: unknown; stepOrder: unknown; steps: unknown };
  sources: unknown;
}): void {
  const def = projection.definition;
  if (typeof def.id !== "string" || def.id.length === 0) {
    throw new Error(
      "sidecar deploy router: workflow.definition.id must be a non-empty string",
    );
  }
  if (!Array.isArray(def.stepOrder) || def.stepOrder.length === 0) {
    throw new Error(
      "sidecar deploy router: workflow.definition.stepOrder must be a non-empty array",
    );
  }
  if (typeof def.steps !== "object" || def.steps === null) {
    throw new Error(
      "sidecar deploy router: workflow.definition.steps must be an object",
    );
  }
  if (typeof projection.sources !== "object" || projection.sources === null) {
    throw new Error(
      "sidecar deploy router: workflow.sources must be an object",
    );
  }
  const steps = def.steps;
  const sources = projection.sources;
  for (const stepId of def.stepOrder) {
    if (typeof stepId !== "string" || stepId.length === 0) {
      throw new Error(
        "sidecar deploy router: workflow.definition.stepOrder entries must be non-empty strings",
      );
    }
    if (!STEP_ID_PATTERN.test(stepId)) {
      throw new Error(
        `sidecar deploy router: stepId ${JSON.stringify(stepId)} must match ${STEP_ID_PATTERN.source}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(steps, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.definition.steps is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(sources, stepId)) {
      throw new Error(
        `sidecar deploy router: workflow.sources is missing entry for stepId ${JSON.stringify(stepId)}`,
      );
    }
    // Boundary type assertion: sources is checked to be a non-null object above; this reads a value to re-check its array shape
    const stepSources = (sources as Record<string, unknown>)[stepId];
    if (!Array.isArray(stepSources) || stepSources.length === 0) {
      throw new Error(
        `sidecar deploy router: workflow.sources[${JSON.stringify(stepId)}] must be a non-empty array (the step's ordered inference-source failover chain)`,
      );
    }
  }
}

/**
 * Project a value into a canonical JSON string with deterministically
 * sorted object keys. Used at the router boundary to mint a stable
 * content hash of the wire-projected workflow definition; the
 * orchestrator's hand-off task computes the same hash from the same
 * canonical form, so a downstream verifier comparing the two values
 * sees byte equality.
 *
 * The shape mirrors the canonicalizer the runlocal repo-store uses
 * for equality checks (`packages/workflow/src/runlocal/repo-store.ts`).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`)
    .join(",")}}`;
}

/**
 * Compute the deploy router's content hash for the wire-projected
 * workflow definition. SHA-256 of the canonical JSON of the
 * `WorkflowDefinition` projection, hex-encoded. The supervisor and the
 * workflow-process child read the value out of the spawn-time env
 * verbatim; it is the deployment's content-addressed handle.
 *
 * The router computes this locally so the multi-step branch does not
 * round-trip the hub for a hash the orchestrator's hand-off task will
 * also derive deterministically from the same canonical form.
 */
export async function computeWireDefinitionHash(
  definition: unknown,
): Promise<string> {
  const canonical = canonicalJsonStringify(definition);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return hexEncode(new Uint8Array(digest));
}
