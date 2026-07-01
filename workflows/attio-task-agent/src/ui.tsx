import { useMemo, useState, type ReactNode } from "react";
import { type } from "arktype";
import {
  Button,
  inputFieldClass,
  type WorkflowPanelProps,
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
  "selectedArtifactKinds?": "string[]",
  "proposedTaskUpdate?": { "markComplete?": "boolean", "note?": "string" },
});
export type ParsedDecision = typeof Decision.infer;

export function parseDecision(raw: unknown): ParsedDecision {
  const inner = peelOutput(raw);
  const parsed = Decision(inner);
  if (parsed instanceof type.errors) return {};
  return parsed;
}

const GeneratedArtifact = type({
  kind: "string",
  title: "string",
  content: "string",
});
const GenerateResult = type({ artifacts: GeneratedArtifact.array() });
export type GeneratedArtifact = typeof GeneratedArtifact.infer;

export function parseArtifacts(raw: unknown): GeneratedArtifact[] {
  const inner = peelOutput(raw);
  const parsed = GenerateResult(inner);
  if (parsed instanceof type.errors) return [];
  return parsed.artifacts;
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
  if (gate === "review") {
    return (
      <Review
        artifacts={parseArtifacts(stepOutputs.generate)}
        pending={signalPending}
        onSubmit={(approvedPieces) => onSignal("review", { approvedPieces })}
      />
    );
  }
  if (gate === "approveSync") {
    const decision = parseDecision(stepOutputs.analyze);
    const record = parseFirstLinkedRecord(stepOutputs.fetchTask);
    return (
      <ApproveSync
        decision={decision}
        record={record}
        pending={signalPending}
        onConfirm={(payload) => onSignal("sync-approval", payload)}
      />
    );
  }

  return <p className="text-sm text-neutral-500">Working…</p>;
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
      <h3 className="text-sm font-medium">
        {needsInput ? "⚠️ The agent needs more info" : "Ready to continue"}
      </h3>
      {props.decision.reasoning ? (
        <p className="text-sm text-neutral-600">{props.decision.reasoning}</p>
      ) : null}
      {questions.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-neutral-700">
          {questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      ) : null}
      {needsInput ? (
        <textarea
          className={inputFieldClass}
          rows={4}
          placeholder="Answer the agent…"
          value={answers}
          onChange={(e) => setAnswers(e.target.value)}
        />
      ) : null}
      <Button disabled={props.pending} onClick={() => props.onSubmit(answers)}>
        {needsInput ? "Send answers" : "Continue"}
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
  pending: boolean;
  onConfirm: (payload: unknown) => void;
}): ReactNode {
  const proposed = props.decision.proposedTaskUpdate;
  const [note, setNote] = useState(proposed?.note ?? "");
  const [markComplete, setMarkComplete] = useState(
    proposed?.markComplete ?? false,
  );
  const canWrite = props.record !== null;
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Write back to Attio?</h3>
      {canWrite ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={markComplete}
              onChange={(e) => setMarkComplete(e.target.checked)}
            />
            Mark the task complete
          </label>
          <textarea
            className={inputFieldClass}
            rows={3}
            placeholder="Note to attach to the record (leave blank to skip)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              disabled={props.pending}
              onClick={() =>
                props.onConfirm({
                  parentObject: props.record?.object,
                  parentRecordId: props.record?.recordId,
                  note: note.trim().length > 0 ? note : undefined,
                  markComplete,
                })
              }
            >
              Write to Attio
            </Button>
            <Button
              variant="secondary"
              disabled={props.pending}
              onClick={() => props.onConfirm({})}
            >
              Skip
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-neutral-500">
            No linked record to write back to.
          </p>
          <Button disabled={props.pending} onClick={() => props.onConfirm({})}>
            Finish
          </Button>
        </>
      )}
    </div>
  );
}
