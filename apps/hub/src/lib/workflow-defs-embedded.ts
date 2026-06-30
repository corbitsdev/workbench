import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { workflowDefinitionEnvelopeSchema } from "@intx/hub-sessions";

// A workflow definition serialized at build time (CL-2593) and committed under
// `apps/hub/generated/workflow-defs/<kind>.json`, so the hub can publish it on
// boot without importing workflow runtime code (the hub image carries no
// workflow source). Only STABLE provenance lives here — `sha`/`deployedAt` are
// stamped at publish time so the committed artifact does not churn per build.
export const EmbeddedWorkflowDefSchema = type({
  kind: "string",
  version: "string",
  "label?": "string",
  "description?": "string",
  definition: workflowDefinitionEnvelopeSchema,
});
export type EmbeddedWorkflowDef = typeof EmbeddedWorkflowDefSchema.infer;

// Directory of committed serialized defs, resolved relative to this module so
// it is correct both in dev (bun runs the TS directly) and in the image (same
// `apps/hub/{src,generated}` layout under `COPY apps/hub/`).
export function embeddedWorkflowDefsDir(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../generated/workflow-defs",
  );
}

// Order-insensitive canonical JSON of a definition, for change detection: the
// embedded def is compared against the currently-published def and a commit is
// skipped when they are equal, so a steady-state boot causes zero churn.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function definitionFingerprint(definition: unknown): string {
  return JSON.stringify(canonicalize(definition));
}
