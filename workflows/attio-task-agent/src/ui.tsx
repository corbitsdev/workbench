import { useMemo, useState, type ReactNode } from "react";
import { type } from "arktype";
import {
  buildRunStepperSteps,
  Button,
  type DisplayStep,
  failedRunErrorMessage,
  HorizontalStepper,
  inputFieldClass,
  LiveStatusSlot,
  liveStatusLabel,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState } from "@intx/workflow";
import { attioTaskArtifactKinds } from "@workbench/shared";

// ── Gate routing ────────────────────────────────────────────────────────────

// The awaitSignal step keys, in order, paired with the signal each fires. The
// active gate is the one whose runtime phase is "awaiting-signal".
export const GATES = [
  { stepId: "selectMember", signal: "member-selection" },
  { stepId: "selectTask", signal: "task-selection" },
  { stepId: "clarify", signal: "clarification" },
  { stepId: "review", signal: "review" },
  { stepId: "approveSync", signal: "sync-approval" },
] as const;

export type GateId = (typeof GATES)[number]["stepId"];

export function activeGate(state: RunState | null): GateId | null {
  for (const gate of GATES) {
    if (state?.steps.get(gate.stepId)?.phase === "awaiting-signal") {
      return gate.stepId;
    }
  }
  return null;
}

// ── Stepper configuration ─────────────────────────────────────────────────────

// Each stepper entry clusters the internal workflow steps it represents, in run
// order. `buildRunStepperSteps` computes status with the "passed = completed OR
// a later step progressed" rule, so a gate whose output is missing can't rewind
// the panel. `activityLabel` drives the live line from in-flight machine work;
// gate-only groups carry none.
const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "setup",
    label: "Task setup",
    stepIds: [
      "listMembers",
      "selectMember",
      "listTasks",
      "selectTask",
      "fetchTask",
    ],
  },
  {
    key: "analyze",
    label: "Analyze",
    stepIds: ["analyze", "clarify"],
    activityLabel: "Analyzing the task",
  },
  {
    key: "generate",
    label: "Act",
    stepIds: ["execute", "reviewArtifacts"],
    activityLabel: "Carrying out the plan",
  },
  {
    key: "review",
    label: "Review",
    stepIds: ["review", "persist"],
    activityLabel: "Saving to workbench",
  },
  {
    key: "sync",
    label: "Sync",
    stepIds: ["suggest", "approveSync", "writeNote", "writeComplete"],
    activityLabel: "Writing back to Attio",
  },
];

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

// ── Output parsing ──────────────────────────────────────────────────────────

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

function parseSelectedTaskId(raw: unknown): string | null {
  const parsed = type({ "taskId?": "string" })(peelOutput(raw));
  if (parsed instanceof type.errors) return null;
  return parsed.taskId ?? null;
}

// ── Shared chrome ─────────────────────────────────────────────────────────────

function Placeholder({ label }: { label: string }): ReactNode {
  return <p className="text-text-3 text-sm">{label}</p>;
}

function ErrorLine({ label }: { label: string }): ReactNode {
  return <p className="text-orange text-sm">{label}</p>;
}

function Reconnecting(): ReactNode {
  return (
    <p className="text-text-3 text-xs">Reconnecting — input unavailable.</p>
  );
}

function Shell(props: {
  state: RunState | null;
  connected: boolean;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const failed =
    props.state?.phase === "failed" || props.state?.phase === "cancelled";
  const liveLabel = failed ? null : liveStatusLabel(props.state, DISPLAY_STEPS);
  return (
    <div className="border-border bg-bg flex h-full flex-col overflow-hidden rounded-panel border">
      <header className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-5 py-3">
        <div className="min-w-0">
          <p className="text-text truncate text-sm font-semibold">
            Attio Task Agent
          </p>
          <p className="text-text-3 mt-px text-xs">
            {props.connected ? "Live" : "Reconnecting…"}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(props.state)} />
      <LiveStatusSlot label={liveLabel} />

      <div className="flex-1 overflow-y-auto p-5">{props.children}</div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps): ReactNode {
  const { state, connected, stepOutputs, signalPending, onSignal } = props;
  const gate = activeGate(state);

  function body(): ReactNode {
    if (gate === "selectMember") {
      const members = parseMembers(stepOutputs.listMembers);
      if (members.status === "pending")
        return <Placeholder label="Loading workspace members…" />;
      if (members.status === "malformed")
        return <ErrorLine label="Couldn't load workspace members." />;
      if (members.value.length === 0)
        return <Placeholder label="No workspace members found." />;
      // Key by the loaded data so the form resets (picking up defaults) when the
      // upstream step output arrives after the gate first mounts.
      return (
        <SelectMember
          key={members.value.map((m) => m.assignee).join(",")}
          members={members.value}
          connected={connected}
          pending={signalPending}
          onSubmit={(assignee) => onSignal("member-selection", { assignee })}
        />
      );
    }
    if (gate === "selectTask") {
      const tasks = parseTasks(stepOutputs.listTasks);
      if (tasks.status === "pending")
        return <Placeholder label="Loading open tasks…" />;
      if (tasks.status === "malformed")
        return <ErrorLine label="Couldn't load the task list." />;
      if (tasks.value.length === 0)
        return <Placeholder label="No open tasks found." />;
      return (
        <SelectTask
          tasks={tasks.value}
          connected={connected}
          pending={signalPending}
          onSubmit={(taskId) => onSignal("task-selection", { taskId })}
        />
      );
    }
    if (gate === "clarify") {
      const decision = parseDecision(stepOutputs.analyze);
      if (decision.status === "pending")
        return <Placeholder label="Analyzing the task…" />;
      if (decision.status === "malformed")
        return <ErrorLine label="Couldn't read the analysis." />;
      return (
        <Clarify
          decision={decision.value}
          connected={connected}
          pending={signalPending}
          onSubmit={(answers) => onSignal("clarification", { answers })}
        />
      );
    }
    if (gate === "review") {
      const artifacts = parseExecutorOutputs(stepOutputs.execute);
      if (artifacts.status === "pending")
        return <Placeholder label="Carrying out the plan…" />;
      if (artifacts.status === "malformed")
        return <ErrorLine label="Couldn't read the produced outputs." />;
      const reviewDecoded = parseReview(stepOutputs.reviewArtifacts);
      const review = reviewDecoded.status === "ok" ? reviewDecoded.value : null;
      return (
        <Review
          key={artifacts.value.map((a) => a.type).join(",")}
          artifacts={artifacts.value}
          review={review}
          connected={connected}
          pending={signalPending}
          onSubmit={(approvedPieces) => onSignal("review", { approvedPieces })}
        />
      );
    }
    if (gate === "approveSync") {
      const decisionDecoded = parseDecision(stepOutputs.analyze);
      const decision =
        decisionDecoded.status === "ok" ? decisionDecoded.value : {};
      const recordDecoded = parseFirstLinkedRecord(stepOutputs.fetchTask);
      const record = recordDecoded.status === "ok" ? recordDecoded.value : null;
      const taskId = parseSelectedTaskId(stepOutputs.selectTask);
      return (
        <ApproveSync
          decision={decision}
          record={record}
          taskId={taskId}
          connected={connected}
          pending={signalPending}
          onConfirm={(payload) => onSignal("sync-approval", payload)}
        />
      );
    }

    // No gate awaiting: the run is either terminal or between steps.
    const terminal = state?.phase;
    if (terminal === "completed") {
      const summary = peelOutput(stepOutputs.suggest);
      return (
        <Done
          summary={typeof summary === "string" ? summary : null}
          onClose={props.onClose}
        />
      );
    }
    if (terminal === "failed" || terminal === "cancelled") {
      return (
        <Failed
          status={terminal}
          errorMessage={failedRunErrorMessage(state)}
          onClose={props.onClose}
        />
      );
    }
    return <Placeholder label="Working…" />;
  }

  return (
    <Shell state={state} connected={connected} onClose={props.onClose}>
      {body()}
    </Shell>
  );
}

function Done(props: {
  summary: string | null;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-text text-sm font-medium">Done</h3>
      {props.summary ? (
        <p className="text-text-2 whitespace-pre-wrap text-sm">
          {props.summary}
        </p>
      ) : (
        <p className="text-text-3 text-sm">Artifacts saved to your library.</p>
      )}
      <Button variant="secondary" onClick={props.onClose}>
        Close
      </Button>
    </div>
  );
}

function Failed(props: {
  status: "failed" | "cancelled";
  errorMessage: string | null;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-text text-sm font-medium">
        {props.status === "cancelled" ? "Cancelled" : "Run failed"}
      </h3>
      <p className="text-text-3 text-sm">
        {props.status === "cancelled"
          ? "This run was cancelled."
          : "Something went wrong. Check the run logs or start a new run."}
      </p>
      {props.status === "failed" && props.errorMessage !== null ? (
        <div className="border-red/40 bg-red-soft/10 max-h-40 overflow-y-auto rounded-lg border p-2">
          <p className="text-red font-mono text-xs break-words whitespace-pre-wrap">
            {props.errorMessage}
          </p>
        </div>
      ) : null}
      <Button variant="secondary" onClick={props.onClose}>
        Close
      </Button>
    </div>
  );
}

function SelectMember(props: {
  members: MemberOption[];
  connected: boolean;
  pending: boolean;
  onSubmit: (assignee: string) => void;
}): ReactNode {
  const [assignee, setAssignee] = useState(props.members[0]?.assignee ?? "");
  const disabled = props.pending || !props.connected;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-text text-sm font-medium">Whose tasks?</h3>
      <select
        className={inputFieldClass}
        value={assignee}
        disabled={disabled}
        onChange={(e) => setAssignee(e.target.value)}
      >
        {props.members.map((m) => (
          <option key={m.assignee} value={m.assignee}>
            {m.label}
          </option>
        ))}
      </select>
      <Button
        disabled={disabled || assignee === ""}
        onClick={() => props.onSubmit(assignee)}
      >
        List tasks
      </Button>
      {!props.connected ? <Reconnecting /> : null}
    </div>
  );
}

function SelectTask(props: {
  tasks: TaskOption[];
  connected: boolean;
  pending: boolean;
  onSubmit: (taskId: string) => void;
}): ReactNode {
  const disabled = props.pending || !props.connected;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-text text-sm font-medium">Pick a task</h3>
      {props.tasks.map((t) => (
        <button
          key={t.taskId}
          disabled={disabled}
          className="border-border hover:bg-surface-2 rounded border p-3 text-left text-sm disabled:opacity-50"
          onClick={() => props.onSubmit(t.taskId)}
        >
          <span className="text-text">{t.label}</span>
          {t.deadline ? (
            <span className="text-text-3 ml-2 text-xs">
              due {t.deadline.slice(0, 10)}
            </span>
          ) : null}
        </button>
      ))}
      {!props.connected ? <Reconnecting /> : null}
    </div>
  );
}

function Clarify(props: {
  decision: ParsedDecision;
  connected: boolean;
  pending: boolean;
  onSubmit: (answers: string) => void;
}): ReactNode {
  const [answers, setAnswers] = useState("");
  const disabled = props.pending || !props.connected;
  const needsInput = props.decision.status === "need_clarification";
  const questions = props.decision.questions ?? [];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-text text-sm font-medium">
        {needsInput ? "More information needed" : "Ready to continue"}
      </h3>
      {props.decision.reasoning ? (
        <p className="text-text-2 text-sm">{props.decision.reasoning}</p>
      ) : null}
      {questions.length > 0 ? (
        <ul className="text-text-2 list-disc pl-5 text-sm">
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : null}
      {needsInput ? (
        <textarea
          className={inputFieldClass}
          rows={4}
          placeholder="Add the missing detail…"
          value={answers}
          disabled={disabled}
          onChange={(e) => setAnswers(e.target.value)}
        />
      ) : null}
      <Button disabled={disabled} onClick={() => props.onSubmit(answers)}>
        Continue
      </Button>
      {!props.connected ? <Reconnecting /> : null}
    </div>
  );
}

function verdictBadge(verdict: string): { label: string; className: string } {
  if (verdict === "pass")
    return { label: "reviewed ✓", className: "text-green" };
  if (verdict === "reject") return { label: "rejected", className: "text-red" };
  return { label: "needs a fix", className: "text-orange" };
}

function Review(props: {
  artifacts: GeneratedArtifact[];
  review: ParsedReview | null;
  connected: boolean;
  pending: boolean;
  onSubmit: (approved: GeneratedArtifact[]) => void;
}): ReactNode {
  const known = useMemo(() => new Set<string>(attioTaskArtifactKinds), []);
  // Default-select everything the reviewer did not reject.
  const verdictFor = (type: string): string | undefined =>
    props.review?.items.find((it) => it.type === type)?.verdict;
  const [selected, setSelected] = useState<Set<number>>(
    () =>
      new Set(
        props.artifacts
          .map((a, i) => ({ a, i }))
          .filter(({ a }) => verdictFor(a.type) !== "reject")
          .map(({ i }) => i),
      ),
  );
  const disabled = props.pending || !props.connected;
  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-text text-sm font-medium">Review</h3>
      {props.review?.overall ? (
        <p className="text-text-2 text-sm">{props.review.overall}</p>
      ) : null}
      {props.artifacts.length === 0 ? (
        <p className="text-text-3 text-sm">
          The plan produced no drafts — nothing to save here.
        </p>
      ) : null}
      {props.artifacts.map((a, i) => {
        const verdict = verdictFor(a.type);
        const notes = props.review?.items.find(
          (it) => it.type === a.type,
        )?.notes;
        return (
          <label
            key={i}
            className="border-border flex flex-col gap-1 rounded border p-3 text-sm"
          >
            <span className="flex gap-2">
              <input
                type="checkbox"
                className="accent-orange mt-0.5"
                checked={selected.has(i)}
                disabled={disabled}
                onChange={() => toggle(i)}
              />
              <span className="min-w-0">
                <span className="text-text font-medium">{a.title}</span>{" "}
                <span className="text-text-3 text-xs">
                  {known.has(a.type) ? a.type : `${a.type} (new type)`}
                </span>
                {verdict ? (
                  <span
                    className={`ml-1 text-xs ${verdictBadge(verdict).className}`}
                  >
                    · {verdictBadge(verdict).label}
                  </span>
                ) : null}
              </span>
            </span>
            {notes && verdict !== "pass" ? (
              <span className="text-text-3 pl-6 text-xs">{notes}</span>
            ) : null}
          </label>
        );
      })}
      <Button
        disabled={disabled}
        onClick={() =>
          props.onSubmit(props.artifacts.filter((_, i) => selected.has(i)))
        }
      >
        Save selected
      </Button>
      {!props.connected ? <Reconnecting /> : null}
    </div>
  );
}

function ApproveSync(props: {
  decision: ParsedDecision;
  record: LinkedRecord | null;
  taskId: string | null;
  connected: boolean;
  pending: boolean;
  onConfirm: (payload: unknown) => void;
}): ReactNode {
  // Keyed by the record so if the bound record changes the form resets rather
  // than showing a stale proposed note (state-from-props guard).
  const recordKey = props.record?.recordId ?? "none";
  return (
    <ApproveSyncForm
      key={recordKey}
      decision={props.decision}
      record={props.record}
      taskId={props.taskId}
      connected={props.connected}
      pending={props.pending}
      onConfirm={props.onConfirm}
    />
  );
}

function ApproveSyncForm(props: {
  decision: ParsedDecision;
  record: LinkedRecord | null;
  taskId: string | null;
  connected: boolean;
  pending: boolean;
  onConfirm: (payload: unknown) => void;
}): ReactNode {
  const [note, setNote] = useState(
    props.decision.proposedTaskUpdate?.note ?? "",
  );
  const disabled = props.pending || !props.connected;
  const canWrite = props.record !== null && props.taskId !== null;
  const noteReady = note.trim().length > 0;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-text text-sm font-medium">Write back to Attio</h3>
      {canWrite ? (
        <>
          <p className="text-text-3 text-xs">
            Attaches the note to {props.record?.object} record{" "}
            {props.record?.recordId} and marks the task complete.
          </p>
          <textarea
            className={inputFieldClass}
            rows={3}
            placeholder="Note to attach to the record…"
            value={note}
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={disabled || !noteReady}
              onClick={() =>
                props.onConfirm({
                  confirm: true,
                  parentObject: props.record?.object,
                  parentRecordId: props.record?.recordId,
                  note,
                  taskId: props.taskId,
                })
              }
            >
              Attach &amp; complete
            </Button>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => props.onConfirm({ confirm: false })}
            >
              Skip
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-text-3 text-sm">
            No linked record to write back to — nothing to sync.
          </p>
          <Button
            disabled={disabled}
            onClick={() => props.onConfirm({ confirm: false })}
          >
            Finish
          </Button>
        </>
      )}
      {!props.connected ? <Reconnecting /> : null}
    </div>
  );
}
