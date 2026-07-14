import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { workflowDefinitionEnvelopeSchema } from "@intx/hub-sessions";
import { EmbeddedIntakeFieldSchema } from "./workflow-gate-info";

// A workflow definition serialized at build time (CL-2593) and committed under
// `apps/hub/generated/workflow-defs/<kind>.json`, so the hub can publish it on
// boot without importing workflow runtime code (the hub image carries no
// workflow source). Only STABLE provenance lives here — `sha`/`deployedAt` are
// stamped at publish time so the committed artifact does not churn per build.
// A workflow author's declared user-facing step flow, serialized alongside the
// def so the server catalog preview groups/labels steps exactly like the client
// run stepper. Kept a SIBLING of `definition` (like `label`/`description`) so it
// never churns the published-definition fingerprint.
export const EmbeddedDisplayFlowStepSchema = type({
  key: "string",
  label: "string",
  stepIds: "string[]",
  "activityLabel?": "string",
});
export type EmbeddedDisplayFlowStep =
  typeof EmbeddedDisplayFlowStepSchema.infer;

export const EmbeddedWorkflowDefSchema = type({
  kind: "string",
  version: "string",
  "label?": "string",
  "description?": "string",
  "displayFlow?": EmbeddedDisplayFlowStepSchema.array(),
  // Gate shape derived from the definition at build time (CL-3508): whether the
  // workflow has an `intake` awaitSignal gate, and its total human-gate count.
  // The scheduling layer uses these to decide which kinds are attachable to a
  // brief without parking forever on a human gate.
  "requiresIntake?": "boolean",
  "humanGateCount?": "number.integer >= 0",
  // The workflow's first-intake form fields, serialized from its `INTAKE_FIELDS`
  // export (CL-3509), so the attach UI can collect the intake payload without
  // importing workflow code. Absent for workflows that declare none.
  "intakeFields?": EmbeddedIntakeFieldSchema.array(),
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
