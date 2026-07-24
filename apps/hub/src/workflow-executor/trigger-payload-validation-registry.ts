import {
  findMissingProspectEngineIntakeFields,
  PROSPECT_ENGINE_REQUIRED_INTAKE_FIELD_LABELS,
  PROSPECT_ENGINE_WORKFLOW_KIND,
} from "@workbench/shared";

export type TriggerPayloadValidationResult =
  | { ok: true }
  | { ok: false; message: string };

type TriggerPayloadValidator = (
  input: Record<string, unknown>,
) => TriggerPayloadValidationResult;

// Per-workflow-kind required-input validation, applied uniformly at every
// run-start door (mirrors trigger-payload-enrichment-registry.ts, which fills
// in server-stamped defaults BEFORE this check runs). A kind's steps read
// required fields straight off `trigger.payload` with no fallback — a missing
// field otherwise surfaces several steps deep as an opaque "field is absent"
// argMap failure. This is the one place that catches a missing required
// input at start and names it in plain language, before any deployment is
// provisioned. A kind absent from this map has no declared required inputs
// and always passes.
const TRIGGER_PAYLOAD_VALIDATORS: Record<string, TriggerPayloadValidator> = {
  [PROSPECT_ENGINE_WORKFLOW_KIND]: (input) => {
    const missing = findMissingProspectEngineIntakeFields(input);
    if (missing.length === 0) return { ok: true };
    const labels = missing.map(
      (field) => PROSPECT_ENGINE_REQUIRED_INTAKE_FIELD_LABELS[field] ?? field,
    );
    const noun = labels.length > 1 ? "inputs" : "input";
    return {
      ok: false,
      message: `Missing required workflow ${noun}: ${labels.join(", ")}. Provide them when starting the run, or set them on a Routine for recurring runs.`,
    };
  },
};

/**
 * Validate a kind's (already enriched) trigger payload before a run starts.
 * Called from every start door AFTER `enrichTriggerPayloadForStart` so
 * server-stamped defaults are already applied — only genuinely missing
 * user-supplied input fails this check.
 */
export function validateTriggerPayloadForStart(
  kind: string,
  input: Record<string, unknown>,
): TriggerPayloadValidationResult {
  const validator = TRIGGER_PAYLOAD_VALIDATORS[kind];
  if (validator === undefined) return { ok: true };
  return validator(input);
}
