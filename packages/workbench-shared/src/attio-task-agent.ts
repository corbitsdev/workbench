import { type } from "arktype";

// Contracts for the Attio Task Agent workflow (CL-2622, CL-2664): list Attio
// tasks → select one → a multi-agent pipeline (planner → executor → reviewer →
// human) that turns the task into a set of drafted BD actions. The PLANNER
// decides the action plan (the agent selects; the human no longer hand-picks);
// the EXECUTOR produces each action; the REVIEWER validates them before the
// human sees them. Destructive write-back stays behind an explicit human gate.
// Schemas are the canonical definitions; the app and the workflow both consume
// them. Pure helpers (normalize/resolve) live here so they are unit-testable
// without the runtime.

// ---------------------------------------------------------------------------
// Attio task (normalized)
// ---------------------------------------------------------------------------

export const AttioLinkedRecordSchema = type({
  object: "string",
  recordId: "string",
});
export type AttioLinkedRecord = typeof AttioLinkedRecordSchema.infer;

export const AttioTaskSchema = type({
  taskId: "string",
  content: "string",
  deadlineAt: "string | null",
  isCompleted: "boolean",
  assigneeIds: "string[]",
  linkedRecords: AttioLinkedRecordSchema.array(),
});
export type AttioTask = typeof AttioTaskSchema.infer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeAssignees(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = readString(entry.referenced_actor_id) ?? readString(entry.id);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function normalizeLinkedRecords(raw: unknown): AttioLinkedRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: AttioLinkedRecord[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const object =
      readString(entry.target_object) ?? readString(entry.target_object_id);
    const recordId = readString(entry.target_record_id);
    if (object !== null && recordId !== null) {
      records.push({ object, recordId });
    }
  }
  return records;
}

/**
 * Normalize a raw Attio task (the nested `/v2/tasks` shape) into the flat
 * {@link AttioTask} the workflow works with. Returns null when the payload is
 * not a task object or lacks a task id — callers filter these out rather than
 * trusting a malformed row.
 */
export function normalizeAttioTask(raw: unknown): AttioTask | null {
  if (!isRecord(raw)) return null;
  const idField = isRecord(raw.id) ? raw.id : {};
  const taskId = readString(idField.task_id);
  if (taskId === null) return null;
  return {
    taskId,
    content: readString(raw.content_plaintext) ?? "",
    deadlineAt: readString(raw.deadline_at),
    isCompleted: raw.is_completed === true,
    assigneeIds: normalizeAssignees(raw.assignees),
    linkedRecords: normalizeLinkedRecords(raw.linked_records),
  };
}

// ---------------------------------------------------------------------------
// Artifact-kind registry (extensible)
// ---------------------------------------------------------------------------

// The kinds the workflow can generate. Adding a kind is a new tuple entry plus a
// registry row — no workflow rewrite. The tuple drives the boundary schema so an
// agent cannot select a kind the workflow does not know how to produce.
export const attioTaskArtifactKinds = [
  "cold-email",
  "follow-up-email",
  "twitter-post",
  "linkedin-post",
  "research-brief",
  "task-explanation",
  "gamma-presentation",
  "blog",
  "single-page-website",
] as const;
export type AttioTaskArtifactKind = (typeof attioTaskArtifactKinds)[number];

export const AttioTaskArtifactKindSchema = type.enumerated(
  ...attioTaskArtifactKinds,
);

export interface ArtifactKindDef {
  key: AttioTaskArtifactKind;
  label: string;
  description: string;
  // Whether the output must scrub identifying details (public social posts).
  anonymized: boolean;
}

export const artifactKindRegistry: Record<
  AttioTaskArtifactKind,
  ArtifactKindDef
> = {
  "cold-email": {
    key: "cold-email",
    label: "Cold email",
    description: "First-touch outreach email to the task's contact.",
    anonymized: false,
  },
  "follow-up-email": {
    key: "follow-up-email",
    label: "Follow-up email",
    description: "Follow-up email continuing a prior thread or meeting.",
    anonymized: false,
  },
  "twitter-post": {
    key: "twitter-post",
    label: "Twitter post",
    description: "Short public post; anonymized (no identifying details).",
    anonymized: true,
  },
  "linkedin-post": {
    key: "linkedin-post",
    label: "LinkedIn post",
    description: "Public LinkedIn post; anonymized (no identifying details).",
    anonymized: true,
  },
  "research-brief": {
    key: "research-brief",
    label: "Research brief",
    description: "Grounded research summary on the company/person and context.",
    anonymized: false,
  },
  "task-explanation": {
    key: "task-explanation",
    label: "Task explanation",
    description: "The task restated with full context and rationale.",
    anonymized: false,
  },
  "gamma-presentation": {
    key: "gamma-presentation",
    label: "Gamma presentation",
    description: "Deck outline suitable for Gamma generation.",
    anonymized: false,
  },
  blog: {
    key: "blog",
    label: "Blog post",
    description: "Long-form blog post derived from the task and research.",
    anonymized: false,
  },
  "single-page-website": {
    key: "single-page-website",
    label: "Single-page website",
    description: "Copy and structure for a single-page landing site.",
    anonymized: false,
  },
};

const artifactKindLookup = new Set<string>(attioTaskArtifactKinds);

/**
 * Partition requested artifact-kind keys into those the registry knows and those
 * it does not, preserving first-seen order and dropping duplicates. The workflow
 * generates the `valid` set and surfaces `unknown` rather than silently ignoring
 * a kind the agent hallucinated.
 */
export function resolveArtifactKinds(requested: string[]): {
  valid: AttioTaskArtifactKind[];
  unknown: string[];
} {
  const valid: AttioTaskArtifactKind[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const key of requested) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (artifactKindLookup.has(key)) {
      valid.push(key as AttioTaskArtifactKind);
    } else {
      unknown.push(key);
    }
  }
  return { valid, unknown };
}

// ---------------------------------------------------------------------------
// Gather / analyze / run state
// ---------------------------------------------------------------------------

export const GatherSourceSchema = type({
  tool: "string",
  summary: "string",
});
export type GatherSource = typeof GatherSourceSchema.infer;

export const GatherResultSchema = type({
  findings: "string",
  sources: GatherSourceSchema.array(),
});
export type GatherResult = typeof GatherResultSchema.infer;

export const AnalyzeStatusSchema = type(
  "'ready' | 'need_clarification' | 'need_more_context'",
);
export type AnalyzeStatus = typeof AnalyzeStatusSchema.infer;

// What the approval gate confirms before any Attio write-back happens.
export const ProposedTaskUpdateSchema = type({
  "markComplete?": "boolean",
  "note?": "string",
});
export type ProposedTaskUpdate = typeof ProposedTaskUpdateSchema.infer;

// ---------------------------------------------------------------------------
// HITL signal payloads (resume-boundary contracts)
// ---------------------------------------------------------------------------

// The member-selection gate picks whose Attio tasks to work. The resume payload
// carries the chosen assignee (an email or workspace_member_id); both the
// fallback panel and the dock choice block POST this exact shape (CL-2731).
export const MemberSelectionPayloadSchema = type({ assignee: "string > 0" });
export type MemberSelectionPayload = typeof MemberSelectionPayloadSchema.infer;

// The task-selection gate picks the task to work. Resume payload carries the
// selected Attio task id — the panel and the dock choice block agree on it.
export const TaskSelectionPayloadSchema = type({ taskId: "string > 0" });
export type TaskSelectionPayload = typeof TaskSelectionPayloadSchema.infer;

// The clarification gate folds the human's free-text answer into `answers`
// (optional — an empty continue is valid; the planner proceeds best-effort). The
// dock prompt-box folds its text under this key; the panel posts the same shape.
export const ClarificationPayloadSchema = type({ "answers?": "string" });
export type ClarificationPayload = typeof ClarificationPayloadSchema.infer;

// The sync-approval gate confirms (or skips) the DESTRUCTIVE Attio write-back.
// This is a two-branch contract so a confirm can never fire a hollow write
// (CL-2684): a SKIP is `{ confirm: false }` and nothing else is needed; a
// CONFIRM (`confirm: true`) REQUIRES the full write locators — the record the
// note attaches to (`parentObject` + `parentRecordId`), the `taskId` to
// complete (duplicated as `idempotencyKey`, attio_create_note's retry-dedupe
// key), and a non-empty `content` — so a confirm with any locator or the note
// missing is rejected at the /resume boundary rather than reaching
// attio_create_note / attio_update_task and writing nothing (or the wrong
// thing). The run-page panel and the dock's block path both assemble these
// field names directly — they are attio_create_note / attio_update_task's own
// arguments, so the write-back steps read this payload with no argMap.
//
// TRANSITIONAL third branch (CL-4232): the pre-rename shape (`note`, no
// `idempotencyKey`) a run parked at this gate before the content/idempotencyKey
// rename deployed may still submit — the dock/panel assembled that payload
// into the client's already-rendered block *before* the deploy, so it is
// submitted *after* the deploy with the old field names. Accepted here and
// folded to the canonical shape by `normalizeSyncApprovalPayload` at the
// /resume boundary (apps/hub/src/workflow-executor/resume-payload-registry.ts)
// before it reaches the write-back steps. DELETE this branch (and the
// normalizer) once no attio-task-agent run can still be parked at sync-approval
// from before that deploy.
export const SyncApprovalPayloadSchema = type({
  confirm: "false",
})
  .or({
    confirm: "true",
    taskId: "string > 0",
    idempotencyKey: "string > 0",
    parentObject: "string > 0",
    parentRecordId: "string > 0",
    content: "string >= 1",
  })
  .or({
    confirm: "true",
    taskId: "string > 0",
    parentObject: "string > 0",
    parentRecordId: "string > 0",
    note: "string >= 1",
  });
export type SyncApprovalPayload = typeof SyncApprovalPayloadSchema.infer;

/**
 * Fold a validated `SyncApprovalPayload` to the canonical write-back shape.
 * A confirm already carrying `content` (the current client shape) passes
 * through untouched; the transitional legacy shape (`note`, no
 * `idempotencyKey`) maps `note` -> `content` and derives `idempotencyKey`
 * from `taskId`, the same way the current client does. See the TRANSITIONAL
 * comment on `SyncApprovalPayloadSchema` for the deletion condition.
 */
export function normalizeSyncApprovalPayload(
  payload: SyncApprovalPayload,
): SyncApprovalPayload {
  if (payload.confirm === false) return payload;
  if ("content" in payload) return payload;
  return {
    confirm: true,
    taskId: payload.taskId,
    idempotencyKey: payload.taskId,
    parentObject: payload.parentObject,
    parentRecordId: payload.parentRecordId,
    content: payload.note,
  };
}

// The planner's unit of work — a NON-DESTRUCTIVE action the executor performs
// (produces an output/draft with no external side effect). `type` names the
// action in an extensible registry (the content kinds today: cold-email,
// linkedin-post, research-brief, … — additive to slack-message-draft,
// email-draft, … as their producers are added; a free string so a new type is
// no schema change). `brief` is the planner's self-contained instruction +
// context, so the executor and reviewer need nothing beyond the item. Each is an
// object so the `generate` map can iterate them (the runtime passes each element
// to the executor as `trigger.payload`).
//
// DESTRUCTIVE actions (anything that sends / posts / writes to an external
// system) never ride here — they are proposed separately (`proposedTaskUpdate`
// today, the wired Attio write-back) and execute only after explicit human
// approval. New destructive action types are additive: a registry entry + a
// deterministic write step behind the approval gate.
export const PlannedActionSchema = type({
  type: "string",
  brief: "string",
});
export type PlannedAction = typeof PlannedActionSchema.infer;

// The planner's decision: it grounds itself read-only, then emits an ACTION PLAN
// — the non-destructive actions to perform now (`draftActions`) plus any proposed
// destructive write-back (`proposedTaskUpdate`), which only executes after human
// approval. The agent selects the plan; the human no longer hand-picks it.
export const AttioAnalyzeDecisionSchema = type({
  status: AnalyzeStatusSchema,
  reasoning: "string",
  "questions?": "string[]",
  "draftActions?": PlannedActionSchema.array(),
  "proposedTaskUpdate?": ProposedTaskUpdateSchema,
});
export type AttioAnalyzeDecision = typeof AttioAnalyzeDecisionSchema.infer;

// What the executor produces per draft action. `type` is echoed from the plan
// (authoritative, not re-derived); `brief` is echoed so the reviewer can judge
// the output against the exact instruction it was given, with no separate join.
export const GeneratedArtifactSchema = type({
  type: "string",
  title: "string",
  content: "string",
  "brief?": "string",
});
export type GeneratedArtifact = typeof GeneratedArtifactSchema.infer;

// The executor runs once for the whole plan and returns all produced outputs.
export const ExecutorOutputSchema = type({
  outputs: GeneratedArtifactSchema.array(),
});
export type ExecutorOutput = typeof ExecutorOutputSchema.infer;

// The reviewer agent's verdict. It receives the produced outputs (each carrying
// its brief) and validates each was done correctly before the human sees them.
export const ArtifactReviewVerdictSchema = type("'pass' | 'revise' | 'reject'");
export type ArtifactReviewVerdict = typeof ArtifactReviewVerdictSchema.infer;

export const ArtifactReviewItemSchema = type({
  type: "string",
  verdict: ArtifactReviewVerdictSchema,
  notes: "string",
});
export type ArtifactReviewItem = typeof ArtifactReviewItemSchema.infer;

export const ArtifactReviewSchema = type({
  overall: "string",
  items: ArtifactReviewItemSchema.array(),
});
export type ArtifactReview = typeof ArtifactReviewSchema.infer;

export type LoopAction = "gather" | "clarify" | "generate";

/**
 * Decide the next loop action from the analyze status, bounding the loop by
 * `maxRounds`. `need_more_context` re-gathers only while rounds remain; once the
 * cap is hit we proceed to generation with the context we have rather than
 * looping forever. `round` is zero-based (the round that just produced the
 * decision).
 */
export function nextLoopAction(
  status: AnalyzeStatus,
  round: number,
  maxRounds: number,
): LoopAction {
  if (status === "ready") return "generate";
  if (status === "need_clarification") return "clarify";
  if (round + 1 < maxRounds) return "gather";
  return "generate";
}

export const AttioTaskRunStatusSchema = type(
  "'selecting' | 'running' | 'awaiting_input' | 'awaiting_approval' | 'complete' | 'failed'",
);
export type AttioTaskRunStatus = typeof AttioTaskRunStatusSchema.infer;

export const AttioTaskRunStateSchema = type({
  runId: "string",
  status: AttioTaskRunStatusSchema,
  round: "number",
  maxRounds: "number",
  "task?": AttioTaskSchema,
  "decision?": AttioAnalyzeDecisionSchema,
  "artifactIds?": "string[]",
});
export type AttioTaskRunState = typeof AttioTaskRunStateSchema.infer;
