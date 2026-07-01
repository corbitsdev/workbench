import { type } from "arktype";

// Contracts for the Attio Task Agent workflow (CL-2622): list Attio tasks →
// select one → a bounded agent loop (gather → analyze → clarify|gather|generate)
// → first-class BD artifacts. Schemas are the canonical definitions; the app and
// the workflow both consume them. Pure helpers (normalize/resolve/loop-action)
// live here so they are unit-testable without the runtime.

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
  return typeof value === "object" && value !== null;
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

// Each selected kind is wrapped in an object so the workflow's `generate` map
// can iterate them and MERGE the shared task/decision context per item — the
// runtime's `merge` selector requires object operands, so a bare string[] can't
// be mapped-with-context. `resolveArtifactKinds` still validates the flat keys.
export const SelectedArtifactKindSchema = type({
  kind: AttioTaskArtifactKindSchema,
});
export type SelectedArtifactKind = typeof SelectedArtifactKindSchema.infer;

export const AttioAnalyzeDecisionSchema = type({
  status: AnalyzeStatusSchema,
  reasoning: "string",
  "questions?": "string[]",
  "selectedArtifactKinds?": SelectedArtifactKindSchema.array(),
  "proposedTaskUpdate?": ProposedTaskUpdateSchema,
});
export type AttioAnalyzeDecision = typeof AttioAnalyzeDecisionSchema.infer;

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
