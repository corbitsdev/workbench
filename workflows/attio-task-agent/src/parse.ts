import { type } from "arktype";

// Pure, React-free decoders for the Attio Task Agent's step outputs (CL-2731).
// Extracted from the panel so both the fallback panel (ui.tsx) and the shared
// dock blocks (blocks.ts) decode the run's step outputs through the exact same
// parsers — the dock preview and the panel can never disagree about what a step
// produced.

// A decoded step output is one of three states so the UI can render "still
// loading" (pending), "the step produced output we can't read" (malformed), and
// "genuinely empty" (ok with an empty value) differently — instead of every
// failure collapsing to [] / {}.
export type Decoded<T> =
  | { status: "pending" }
  | { status: "malformed" }
  | { status: "ok"; value: T };

// Deterministic tool outputs arrive as a `{ content: string }` envelope whose
// content is JSON; inference/agent steps arrive as `{ reply: string }` or a bare
// object. `peelOutput` returns the inner value for any of these shapes.
const Envelope = type({ "content?": "string", "reply?": "string" });

// Parse JSON that a model may have wrapped in a ```json fence or prefixed with
// prose — a bare JSON.parse silently drops those, which loses the whole artifact
// or decision (the writer model routinely fences at 16k tokens). Falls back to
// the first {...} / [...] slice.
function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // strip a leading/trailing code fence
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const body = fenced?.[1] ?? text;
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return text;
      }
    }
    return text;
  }
}

export function peelOutput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  const env = Envelope(raw);
  if (!(env instanceof type.errors)) {
    const text = env.content ?? env.reply;
    if (typeof text === "string") return parseLooseJson(text);
  }
  return raw;
}

// A step with no output yet is `pending`; once output arrives it is peeled and
// handed to the caller's schema, which decides `ok` vs `malformed`.
function peelDecoded(
  raw: unknown,
): { status: "pending" } | { status: "peeled"; value: unknown } {
  if (raw === undefined || raw === null) return { status: "pending" };
  return { status: "peeled", value: peelOutput(raw) };
}

const MemberItem = type({
  id: { workspace_member_id: "string" },
  "email_address?": "string",
  "email?": "string",
  "first_name?": "string",
  "last_name?": "string",
});
const MemberArray = MemberItem.array();

export type MemberOption = { assignee: string; label: string };

export function parseMembers(raw: unknown): Decoded<MemberOption[]> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = MemberArray(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return {
    status: "ok",
    value: parsed.map((m) => {
      const email = m.email_address ?? m.email;
      const name = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
      const label =
        name.length > 0 ? name : (email ?? m.id.workspace_member_id);
      return { assignee: email ?? m.id.workspace_member_id, label };
    }),
  };
}

const TaskItem = type({
  id: { task_id: "string" },
  "content_plaintext?": "string",
  "deadline_at?": "string | null",
});
const TaskArray = TaskItem.array();

export type TaskOption = { taskId: string; label: string; deadline?: string };

export function parseTasks(raw: unknown): Decoded<TaskOption[]> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = TaskArray(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return {
    status: "ok",
    value: parsed.map((t) => ({
      taskId: t.id.task_id,
      label:
        t.content_plaintext && t.content_plaintext.length > 0
          ? t.content_plaintext
          : t.id.task_id,
      ...(t.deadline_at ? { deadline: t.deadline_at } : {}),
    })),
  };
}

const Decision = type({
  "status?": "string",
  "reasoning?": "string",
  "questions?": "string[]",
  "draftActions?": type({ type: "string", "brief?": "string" }).array(),
  "proposedTaskUpdate?": { "markComplete?": "boolean", "note?": "string" },
});
export type ParsedDecision = typeof Decision.infer;

export function parseDecision(raw: unknown): Decoded<ParsedDecision> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = Decision(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}

// The executor returns one produced output per draft action, in `{ outputs: [...] }`.
const GeneratedItem = type({
  type: "string",
  title: "string",
  content: "string",
  "brief?": "string",
});
const ExecutorOutput = type({ outputs: GeneratedItem.array() });
export type GeneratedArtifact = typeof GeneratedItem.infer;

// The executor is one step producing all outputs. `pending` = it has not landed
// yet; `malformed` = it landed but didn't parse; `ok` returns the produced
// outputs (an empty array is a valid "the plan needed no drafts" result).
export function parseExecutorOutputs(
  raw: unknown,
): Decoded<GeneratedArtifact[]> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = ExecutorOutput(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.outputs };
}

// The reviewer's per-output verdicts, keyed by action type for display.
const ReviewItem = type({
  type: "string",
  verdict: "'pass' | 'revise' | 'reject'",
  notes: "string",
});
const ReviewResult = type({ overall: "string", items: ReviewItem.array() });
export type ParsedReview = typeof ReviewResult.infer;

export function parseReview(raw: unknown): Decoded<ParsedReview> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = ReviewResult(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed };
}

const LinkedRecordRef = type({ object: "string", recordId: "string" });
const FetchTaskResult = type({ "linkedRecords?": LinkedRecordRef.array() });

export type LinkedRecord = { object: string; recordId: string };

export function parseFirstLinkedRecord(
  raw: unknown,
): Decoded<LinkedRecord | null> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = FetchTaskResult(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.linkedRecords?.[0] ?? null };
}

export function parseSelectedTaskId(raw: unknown): Decoded<string | null> {
  const peeled = peelDecoded(raw);
  if (peeled.status === "pending") return { status: "pending" };
  const parsed = type({ "taskId?": "string" })(peeled.value);
  if (parsed instanceof type.errors) return { status: "malformed" };
  return { status: "ok", value: parsed.taskId ?? null };
}

// Zip the reviewer's verdicts onto the produced drafts BY INDEX — the reviewer
// is contracted to return one item per output in the same order. Joining by
// `type` would misattribute when a plan has two drafts of the same type (e.g.
// two cold-emails): `find` would tag both with the first's verdict. `null`
// review (absent/pending/malformed) yields drafts with no verdict.
export type ReviewedDraft = {
  draft: GeneratedArtifact;
  verdict?: "pass" | "revise" | "reject";
  notes?: string;
};

export function mergeReview(
  drafts: GeneratedArtifact[],
  review: ParsedReview | null,
): ReviewedDraft[] {
  return drafts.map((draft, i) => {
    const item = review?.items[i];
    if (item === undefined) return { draft };
    return { draft, verdict: item.verdict, notes: item.notes };
  });
}

// Safe default selection: with a review, pre-check only what the agent PASSED
// (a `revise`/`reject` must be opted into, not out of). With no review yet,
// pre-check everything — there is no signal to withhold on.
export function defaultSelectedIndices(
  reviewed: ReviewedDraft[],
  hasReview: boolean,
): Set<number> {
  const out = new Set<number>();
  reviewed.forEach((r, i) => {
    if (!hasReview || r.verdict === "pass") out.add(i);
  });
  return out;
}
