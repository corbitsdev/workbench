import { type, type Type } from "arktype";
import {
  AbPresetConfigPayloadSchema,
  AbDecisionPayloadSchema,
  ClarificationPayloadSchema,
  CompetitorAnalysisIntakePayloadSchema,
  CompetitorAnalysisReviewPayloadSchema,
  Last30daysIntakePayloadSchema,
  MemberSelectionPayloadSchema,
  RedditIntakePayloadSchema,
  RedditReviewPayloadSchema,
  RedditSelectionPayloadSchema,
  GammaIntakePayloadSchema,
  GtmScriptsBriefsIntakePayloadSchema,
  MultiSourceOptionsPayloadSchema,
  MultiSourceReviewFinalPayloadSchema,
  MultiSourceReviewPayloadSchema,
  MultiSourceSourcesPayloadSchema,
  multiSourceSourcesHasAtLeastOne,
  normalizeSyncApprovalPayload,
  PainPointContextPayloadSchema,
  PainPointFormatSelectionPayloadSchema,
  PainPointNoteSelectionPayloadSchema,
  PainPointReviewPayloadSchema,
  PainPointSelectionPayloadSchema,
  SumbleIntakePayloadSchema,
  SumbleReviewPayloadSchema,
  ProspectEngineIntakePayloadSchema,
  SyncApprovalPayloadSchema,
  TaskSelectionPayloadSchema,
} from "@workbench/shared";

// The gamma-presentation-creator workflow is single-shot: one
// `intake` gate carries the deck brief (CL-2684); there is no preview/round
// gate anymore.
const GAMMA_SIGNALS: Record<string, Type> = {
  intake: GammaIntakePayloadSchema,
};

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
  // The curated A/B presets (CL-3074): the config gate collects ONLY the shared
  // prompt (the models are fixed at definition time), so it validates against the
  // prompt-only schema; the human pick is a non-empty ranking. Keyed per preset
  // kind so the prompt-only config shape is enforced for each.
  "ab-compare-quality": {
    "ab-config": AbPresetConfigPayloadSchema,
    "ab-decision": AbDecisionPayloadSchema,
  },
  "ab-compare-speed": {
    "ab-config": AbPresetConfigPayloadSchema,
    "ab-decision": AbDecisionPayloadSchema,
  },
  "ab-compare-standard": {
    "ab-config": AbPresetConfigPayloadSchema,
    "ab-decision": AbDecisionPayloadSchema,
  },
  // gamma-presentation-creator (single-shot): the `intake` gate
  // REQUIRES a deck title + a Gamma template (CL-2684) — the render step
  // reads both. There is no preview/round gate; the run generates once and
  // persists.
  "gamma-presentation-creator": GAMMA_SIGNALS,
  // gtm-scripts-briefs (CL-4031): retrieval and grounding require a non-empty
  // topic and positive research window before the writer can select a story.
  "gtm-scripts-briefs": {
    intake: GtmScriptsBriefsIntakePayloadSchema,
  },
  // last30days-research (CL-2765): the one `intake` gate REQUIRES a non-empty
  // topic — every source query and the report title derive from it, so a
  // topic-less intake is rejected here rather than grounding the scan on nothing.
  // The block form and the run-page panel POST the same shape.
  "last30days-research": {
    intake: Last30daysIntakePayloadSchema,
  },
  // reddit-opportunity-scanner (CL-2769): all three gates carry structured
  // payloads the deterministic map steps read. The intake gate REQUIRES an
  // http(s) URL (the scrape step fetches it); the review gate REQUIRES at least
  // one keyword, subreddit, and search row (the collect step maps over the
  // searches); the selection gate REQUIRES at least one selected opportunity
  // with a non-empty title + content (the persist step maps each into an
  // artifact). The block UIBlocks and the run-page panel POST the same shapes.
  "reddit-opportunity-scanner": {
    intake: RedditIntakePayloadSchema,
    "recommendation-review": RedditReviewPayloadSchema,
    "opportunity-selection": RedditSelectionPayloadSchema,
  },
  // pain-point-collateral (CL-2775): four gates migrated to dock UIBlocks (choice
  // / form / form / reviewList) and `format-selection` kept on the run-page panel.
  // Registering all five rejects a malformed resume at the boundary — a note-less
  // selection, a content-less approved piece (the fidelity contract: the persist
  // argMap reads title/format/content, so an empty-content piece would persist a
  // hollow artifact), a format item without a pain point — rather than poisoning
  // the downstream fetch/persist steps. The dock blocks and the panel POST the
  // same shapes.
  "pain-point-collateral": {
    "note-selection": PainPointNoteSelectionPayloadSchema,
    context: PainPointContextPayloadSchema,
    "pain-point-selection": PainPointSelectionPayloadSchema,
    "format-selection": PainPointFormatSelectionPayloadSchema,
    review: PainPointReviewPayloadSchema,
  },
  // multi-source-collateral (CL-4034): multi-select sources → options items →
  // review (good/bad + optional one-pass regenerate) → review-final when regenerating.
  // Sources also require at least one of artifacts/notes/issues/text (see
  // validateResumePayload cross-field check).
  "multi-source-collateral": {
    sources: MultiSourceSourcesPayloadSchema,
    options: MultiSourceOptionsPayloadSchema,
    review: MultiSourceReviewPayloadSchema,
    "review-final": MultiSourceReviewFinalPayloadSchema,
  },
  // sumble-account-intel (CL-3424): the intake gate REQUIRES a non-empty
  // organization domain/slug — every Sumble lookup keys off it, so a blank
  // intake is rejected at the /resume boundary rather than resolving nothing.
  // The review gate carries the approval decision and the optional Attio-push
  // flag. The block form and the run-page panel POST the same shapes.
  "sumble-account-intel": {
    intake: SumbleIntakePayloadSchema,
    review: SumbleReviewPayloadSchema,
  },
  // competitor-analysis (CL-4029): the intake gate REQUIRES an http(s) company
  // URL — the scrape step fetches it, so a blank/non-URL intake is rejected at
  // the /resume boundary rather than failing deep in the crawl. The review gate
  // carries the approval decision before the report is persisted. The block form
  // and the run-page panel POST the same shapes.
  "competitor-analysis": {
    intake: CompetitorAnalysisIntakePayloadSchema,
    review: CompetitorAnalysisReviewPayloadSchema,
  },
  // prospect-engine (CL-3497): schedule/attach intake for list ids + Slack +
  // optional verticals. Fire-time enrichment builds the full trigger payload.
  "prospect-engine": {
    intake: ProspectEngineIntakePayloadSchema,
  },
  // Multi-gate scheduler integration fixture (CL-3528): intake then a post-intake
  // confirm gate with an empty payload — exercises scheduled Myra gate-drive.
  "scheduler-multi-gate-test": {
    intake: type({ note: "string" }),
    confirm: type({}),
  },
};

export type ResumePayloadValidation =
  | { ok: true; payload?: unknown }
  | { ok: false; error: string };

/**
 * Validate a resume signal payload against the registered schema for its
 * workflow kind + signal name. Returns `{ ok: true }` when there is no
 * registered schema (pass-through) or the payload matches; `{ ok: false }` with
 * an error summary on a registered-but-mismatched payload.
 *
 * A registered schema may also NORMALIZE the payload (e.g. folding a
 * transitional legacy shape to the current one) — when it does, `payload`
 * carries the normalized value the caller should dispatch instead of the raw
 * submitted one. Every other kind/signal leaves `payload` unset and the
 * caller keeps using the raw payload it received (pass-through, unchanged).
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
  if (
    kind === "multi-source-collateral" &&
    signalName === "sources" &&
    !multiSourceSourcesHasAtLeastOne(out)
  ) {
    return {
      ok: false,
      error:
        "sources requires at least one artifact, note, Linear issue, or non-empty text",
    };
  }
  if (
    kind === "multi-source-collateral" &&
    signalName === "review" &&
    out.shouldRegenerate === true &&
    out.regenerateItems.length === 0
  ) {
    return {
      ok: false,
      error: "shouldRegenerate requires at least one regenerateItems entry",
    };
  }
  if (kind === "attio-task-agent" && signalName === "sync-approval") {
    return { ok: true, payload: normalizeSyncApprovalPayload(out) };
  }
  return { ok: true };
}

export function describeResumePayload(
  kind: string,
  signalName: string,
): string | undefined {
  const schema = RESUME_PAYLOAD_SCHEMAS[kind]?.[signalName];
  if (schema === undefined) return undefined;
  return String(schema.expression);
}

/**
 * The required top-level keys of a kind's registered `intake` resume-payload
 * schema (read via arktype's JSON Schema projection). Used to assert a
 * workflow's declared intake fields (`INTAKE_FIELDS`) actually cover every key
 * the `/resume` boundary requires — the gap that shipped `gtm-scripts-briefs`
 * with a schedule form collecting nothing against a schema requiring
 * `topic`/`days` (CL-4538). Returns `undefined` when the kind has no
 * registered `intake` schema — nothing to check.
 */
export function requiredIntakeSchemaKeys(kind: string): string[] | undefined {
  const schema = RESUME_PAYLOAD_SCHEMAS[kind]?.intake;
  if (schema === undefined) return undefined;
  // Several registered schemas narrow a leaf type with `.narrow(...)` (e.g.
  // `topic`'s non-empty-string check) — arktype's JSON Schema projection has
  // no representation for an arbitrary predicate and throws unless a
  // `fallback` is supplied. Only the required-KEY list is needed here (not
  // the predicate itself), so the fallback degrades a narrowed leaf to its
  // unrefined base type.
  const jsonSchema = schema.toJsonSchema({
    fallback: { predicate: (ctx) => ctx.base },
  }) as { required?: unknown };
  const required = jsonSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((key): key is string => typeof key === "string");
}
