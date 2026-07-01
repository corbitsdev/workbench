import { useMemo, useState, type ReactNode } from "react";
import { type } from "arktype";
import {
  Button,
  inputFieldClass,
  type WorkflowPanelProps,
} from "@workbench/ui";
import type { RunState } from "@intx/workflow";
import {
  artifactKindRegistry,
  attioTaskArtifactKinds,
  type AttioTaskArtifactKind,
} from "@workbench/shared";

// ── Gate routing ────────────────────────────────────────────────────────────

// The awaitSignal step keys, in order, paired with the signal each fires. The
// active gate is the one whose runtime phase is "awaiting-signal".
export const GATES = [
  { stepId: "selectMember", signal: "member-selection" },
  { stepId: "selectTask", signal: "task-selection" },
  { stepId: "clarify", signal: "clarification" },
  { stepId: "selectKinds", signal: "kind-selection" },
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

// ── Output parsing ──────────────────────────────────────────────────────────

// Deterministic tool outputs arrive as a `{ content: string }` envelope whose
// content is JSON; inference/agent steps arrive as `{ reply: string }` or a bare
// object. `peelOutput` returns the inner value for any of these shapes.
const Envelope = type({ "content?": "string", "reply?": "string" });

export function peelOutput(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  const env = Envelope(raw);
  if (!(env instanceof type.errors)) {
    const text = env.content ?? env.reply;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return raw;
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

export function parseMembers(raw: unknown): MemberOption[] {
  const inner = peelOutput(raw);
  const parsed = MemberArray(inner);
  if (parsed instanceof type.errors) return [];
  return parsed.map((m) => {
    const email = m.email_address ?? m.email;
    const name = [m.first_name, m.last_name].filter(Boolean).join(" ").trim();
    const label = name.length > 0 ? name : (email ?? m.id.workspace_member_id);
    return { assignee: email ?? m.id.workspace_member_id, label };
  });
}

const TaskItem = type({
  id: { task_id: "string" },
  "content_plaintext?": "string",
  "deadline_at?": "string | null",
});
const TaskArray = TaskItem.array();

export type TaskOption = { taskId: string; label: string; deadline?: string };

export function parseTasks(raw: unknown): TaskOption[] {
  const inner = peelOutput(raw);
  const parsed = TaskArray(inner);
  if (parsed instanceof type.errors) return [];
  return parsed.map((t) => ({
    taskId: t.id.task_id,
    label:
      t.content_plaintext && t.content_plaintext.length > 0
        ? t.content_plaintext
        : t.id.task_id,
    ...(t.deadline_at ? { deadline: t.deadline_at } : {}),
  }));
}

const Decision = type({
  "status?": "string",
  "reasoning?": "string",
  "questions?": "string[]",
  "selectedArtifactKinds?": type({ kind: "string" }).array(),
  "proposedTaskUpdate?": { "markComplete?": "boolean", "note?": "string" },
});
export type ParsedDecision = typeof Decision.infer;

export function parseDecision(raw: unknown): ParsedDecision {
  const inner = peelOutput(raw);
  const parsed = Decision(inner);
  if (parsed instanceof type.errors) return {};
  return parsed;
}

// The agent's suggested kinds, narrowed to the ones the workflow can produce —
// the panel pre-checks these in the kind picker.
export function suggestedKinds(
  decision: ParsedDecision,
): AttioTaskArtifactKind[] {
  const known = new Set<string>(attioTaskArtifactKinds);
  return (decision.selectedArtifactKinds ?? [])
    .map((s) => s.kind)
    .filter((k): k is AttioTaskArtifactKind => known.has(k));
}

const GeneratedArtifact = type({
  kind: "string",
  title: "string",
  content: "string",
});
export type GeneratedArtifact = typeof GeneratedArtifact.infer;

// Each kind that ran produced its own `gen-<kind>` step output. Aggregate the
// ones that resolved to a valid artifact; a kind whose branch was pruned (not
// selected) simply has no output.
export function parseGeneratedByKind(
  stepOutputs: Record<string, unknown>,
): GeneratedArtifact[] {
  const out: GeneratedArtifact[] = [];
  for (const kind of attioTaskArtifactKinds) {
    const parsed = GeneratedArtifact(peelOutput(stepOutputs[`gen-${kind}`]));
    if (!(parsed instanceof type.errors)) out.push(parsed);
  }
  return out;
}

const LinkedRecordRef = type({ object: "string", recordId: "string" });
const FetchTaskResult = type({ "linkedRecords?": LinkedRecordRef.array() });

export function parseFirstLinkedRecord(
  raw: unknown,
): { object: string; recordId: string } | null {
  const inner = peelOutput(raw);
  const parsed = FetchTaskResult(inner);
  if (parsed instanceof type.errors) return null;
  return parsed.linkedRecords?.[0] ?? null;
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps): ReactNode {
  const { state, stepOutputs, signalPending, onSignal } = props;
  const gate = activeGate(state);

  if (gate === "selectMember") {
    return (
      <SelectMember
        members={parseMembers(stepOutputs.listMembers)}
        pending={signalPending}
        onSubmit={(assignee) => onSignal("member-selection", { assignee })}
      />
    );
  }
  if (gate === "selectTask") {
    return (
      <SelectTask
        tasks={parseTasks(stepOutputs.listTasks)}
        pending={signalPending}
        onSubmit={(taskId) => onSignal("task-selection", { taskId })}
      />
    );
  }
  if (gate === "clarify") {
    return (
      <Clarify
        decision={parseDecision(stepOutputs.analyze)}
        pending={signalPending}
        onSubmit={(answers) => onSignal("clarification", { answers })}
      />
    );
  }
  if (gate === "selectKinds") {
    return (
      <SelectKinds
        suggested={suggestedKinds(parseDecision(stepOutputs.analyze))}
        pending={signalPending}
        onSubmit={(generate) => onSignal("kind-selection", { generate })}
      />
    );
  }
  if (gate === "review") {
    return (
      <Review
        artifacts={parseGeneratedByKind(stepOutputs)}
        pending={signalPending}
        onSubmit={(approvedPieces) => onSignal("review", { approvedPieces })}
      />
    );
  }
  if (gate === "approveSync") {
    const decision = parseDecision(stepOutputs.analyze);
    const record = parseFirstLinkedRecord(stepOutputs.fetchTask);
    const taskId = parseSelectedTaskId(stepOutputs.selectTask);
    return (
      <ApproveSync
        decision={decision}
        record={record}
        taskId={taskId}
        pending={signalPending}
        onConfirm={(payload) => onSignal("sync-approval", payload)}
      />
    );
  }

  return <p className="text-text-3 text-sm">Working…</p>;
}

function parseSelectedTaskId(raw: unknown): string | null {
  const parsed = type({ "taskId?": "string" })(peelOutput(raw));
  if (parsed instanceof type.errors) return null;
  return parsed.taskId ?? null;
}

function SelectMember(props: {
  members: MemberOption[];
  pending: boolean;
  onSubmit: (assignee: string) => void;
}): ReactNode {
  const [assignee, setAssignee] = useState(props.members[0]?.assignee ?? "");
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Whose tasks?</h3>
      <select
        className={inputFieldClass}
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
      >
        {props.members.map((m) => (
          <option key={m.assignee} value={m.assignee}>
            {m.label}
          </option>
        ))}
      </select>
      <Button
        disabled={props.pending || assignee === ""}
        onClick={() => props.onSubmit(assignee)}
      >
        List tasks
      </Button>
    </div>
  );
}

function SelectTask(props: {
  tasks: TaskOption[];
  pending: boolean;
  onSubmit: (taskId: string) => void;
}): ReactNode {
  if (props.tasks.length === 0) {
    return <p className="text-sm text-neutral-500">No open tasks found.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Pick a task</h3>
      {props.tasks.map((t) => (
        <button
          key={t.taskId}
          disabled={props.pending}
          className="rounded border border-neutral-200 p-3 text-left text-sm hover:bg-neutral-50 disabled:opacity-50"
          onClick={() => props.onSubmit(t.taskId)}
        >
          <span>{t.label}</span>
          {t.deadline ? (
            <span className="ml-2 text-xs text-neutral-400">
              due {t.deadline.slice(0, 10)}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function Clarify(props: {
  decision: ParsedDecision;
  pending: boolean;
  onSubmit: (answers: string) => void;
}): ReactNode {
  const [answers, setAnswers] = useState("");
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
          onChange={(e) => setAnswers(e.target.value)}
        />
      ) : null}
      <Button disabled={props.pending} onClick={() => props.onSubmit(answers)}>
        Continue
      </Button>
    </div>
  );
}

// The kind picker: pre-checks the agent's suggested kinds, and always emits a
// COMPLETE boolean map over every kind so no per-kind gate reads a missing key.
function SelectKinds(props: {
  suggested: AttioTaskArtifactKind[];
  pending: boolean;
  onSubmit: (generate: Record<AttioTaskArtifactKind, boolean>) => void;
}): ReactNode {
  const [checked, setChecked] = useState<Set<AttioTaskArtifactKind>>(
    () => new Set(props.suggested),
  );
  const toggle = (kind: AttioTaskArtifactKind) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  const submit = () => {
    const generate = {} as Record<AttioTaskArtifactKind, boolean>;
    for (const kind of attioTaskArtifactKinds)
      generate[kind] = checked.has(kind);
    props.onSubmit(generate);
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-text text-sm font-medium">Which artifacts?</h3>
      {attioTaskArtifactKinds.map((kind) => (
        <label
          key={kind}
          className="border-border flex gap-2 rounded-input border p-3 text-sm"
        >
          <input
            type="checkbox"
            className="accent-orange"
            checked={checked.has(kind)}
            onChange={() => toggle(kind)}
          />
          <span className="text-text">{artifactKindRegistry[kind].label}</span>
        </label>
      ))}
      <Button disabled={props.pending || checked.size === 0} onClick={submit}>
        Generate {checked.size} artifact{checked.size === 1 ? "" : "s"}
      </Button>
    </div>
  );
}

function Review(props: {
  artifacts: GeneratedArtifact[];
  pending: boolean;
  onSubmit: (approved: GeneratedArtifact[]) => void;
}): ReactNode {
  const known = useMemo(() => new Set<string>(attioTaskArtifactKinds), []);
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(props.artifacts.map((_, i) => i)),
  );
  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Review artifacts</h3>
      {props.artifacts.map((a, i) => (
        <label
          key={i}
          className="flex gap-2 rounded border border-neutral-200 p-3 text-sm"
        >
          <input
            type="checkbox"
            checked={selected.has(i)}
            onChange={() => toggle(i)}
          />
          <span>
            <span className="font-medium">{a.title}</span>{" "}
            <span className="text-xs text-neutral-400">
              {known.has(a.kind) ? a.kind : `${a.kind} (unknown kind)`}
            </span>
          </span>
        </label>
      ))}
      <Button
        disabled={props.pending}
        onClick={() =>
          props.onSubmit(props.artifacts.filter((_, i) => selected.has(i)))
        }
      >
        Save selected
      </Button>
    </div>
  );
}

function ApproveSync(props: {
  decision: ParsedDecision;
  record: { object: string; recordId: string } | null;
  taskId: string | null;
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
      pending={props.pending}
      onConfirm={props.onConfirm}
    />
  );
}

function ApproveSyncForm(props: {
  decision: ParsedDecision;
  record: { object: string; recordId: string } | null;
  taskId: string | null;
  pending: boolean;
  onConfirm: (payload: unknown) => void;
}): ReactNode {
  const [note, setNote] = useState(
    props.decision.proposedTaskUpdate?.note ?? "",
  );
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
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={props.pending || !noteReady}
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
              disabled={props.pending}
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
            disabled={props.pending}
            onClick={() => props.onConfirm({ confirm: false })}
          >
            Finish
          </Button>
        </>
      )}
    </div>
  );
}
