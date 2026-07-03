import { type, type Type } from "arktype";
import {
  AbConfigPayloadSchema,
  AbDecisionPayloadSchema,
  ClarificationPayloadSchema,
  MemberSelectionPayloadSchema,
  GammaPreviewPayloadSchema,
  SyncApprovalPayloadSchema,
  TaskSelectionPayloadSchema,
} from "@workbench/shared";

// The gamma-presentation-creator workflow parks a `preview-<round>` gate per
// round (MAX_ROUNDS = 3 in the workflow def); every one carries the same
// approve/refine decision shape, so validate each with the same schema.
const GAMMA_PREVIEW_SIGNALS: Record<string, Type> = Object.fromEntries(
  [1, 2, 3].map((round) => [`preview-${round}`, GammaPreviewPayloadSchema]),
);

// Per-workflow-kind → per-signal-name resume-payload validators. The /resume
// route is generic across every workflow; the raw resume payload is otherwise
// written straight into step outputs unvalidated. Registering a schema here
// pulls a gate's completeness/shape invariant to the trust boundary so a
// malformed payload is rejected with 400 instead of poisoning downstream steps.
//
// Any workflow/signal NOT in this registry validates as pass-through — existing
// workflows are untouched. Only add an entry when the payload shape is a real
// contract worth enforcing at the boundary.
const RESUME_PAYLOAD_SCHEMAS: Record<string, Record<string, Type>> = {
  // attio-task-agent (CL-2731): the block-driven HITL gates carry structured
  // payloads. Registering their shapes rejects a hollow/malformed resume at the
  // boundary — a member pick without an assignee, a task pick without a taskId —
  // rather than writing it into step outputs and poisoning the downstream tool
  // step. The panel and the dock choice blocks POST the same shapes.
  "attio-task-agent": {
    "member-selection": MemberSelectionPayloadSchema,
    "task-selection": TaskSelectionPayloadSchema,
    clarification: ClarificationPayloadSchema,
    "sync-approval": SyncApprovalPayloadSchema,
  },
  // ab-compare-hitl (CL-2683): both gates carry a structured payload. The blind
  // winner-pick REQUIRES a non-empty ranking — a free-text `{ instruction }` is
  // rejected here rather than composing a winner-less artifact — and the config
  // gate REQUIRES fully-specified variants + input.
  "ab-compare-hitl": {
    "ab-decision": AbDecisionPayloadSchema,
    "ab-config": AbConfigPayloadSchema,
  },
  // gamma-presentation-creator (CL-2730): each preview gate's approve/refine
  // decision REQUIRES a boolean `approved` — the `check-N` gate branches on it,
  // so a payload with no decision is rejected here rather than mis-routing the
  // round. A refine (`approved: false`) additionally REQUIRES a non-empty
  // `feedback` — the next round's generate step revises from it, so a
  // guidance-less refine is rejected rather than blind re-rolling; an approve
  // needs no note.
  "gamma-presentation-creator": GAMMA_PREVIEW_SIGNALS,
};

export type ResumePayloadValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate a resume signal payload against the registered schema for its
 * workflow kind + signal name. Returns `{ ok: true }` when there is no
 * registered schema (pass-through) or the payload matches; `{ ok: false }` with
 * an error summary on a registered-but-mismatched payload.
 */
export function validateResumePayload(
  kind: string,
  signalName: string,
  payload: unknown,
): ResumePayloadValidation {
  const schema = RESUME_PAYLOAD_SCHEMAS[kind]?.[signalName];
  if (schema === undefined) return { ok: true };
  const out = schema(payload);
  if (out instanceof type.errors) {
    return { ok: false, error: out.summary };
  }
  return { ok: true };
}
