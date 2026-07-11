import { useMemo, useState, type ReactNode } from "react";
import {
  buildRunStepperSteps,
  Button,
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
import { DISPLAY_STEPS } from "./display-steps";
import {
  defaultSelectedIndices,
  mergeReview,
  parseDecision,
  parseExecutorOutputs,
  parseFirstLinkedRecord,
  parseMembers,
  parseReview,
  parseSelectedTaskId,
  parseTasks,
  peelOutput,
  type GeneratedArtifact,
  type LinkedRecord,
  type MemberOption,
  type ParsedDecision,
  type ParsedReview,
  type TaskOption,
} from "./parse";

// Re-exported for existing importers (the panel's own test suite) — the pure
// decoders now live in ./parse so blocks.ts can share them (CL-2731).
export {
  defaultSelectedIndices,
  mergeReview,
  parseDecision,
  parseExecutorOutputs,
  parseFirstLinkedRecord,
  parseMembers,
  parseReview,
  parseSelectedTaskId,
  parseTasks,
  peelOutput,
  type Decoded,
  type GeneratedArtifact,
  type LinkedRecord,
  type MemberOption,
  type ParsedDecision,
  type ParsedReview,
  type ReviewedDraft,
  type TaskOption,
} from "./parse";

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
// The display flow (order, labels, grouping, activity lines) is declared once in
// the browser-safe ./display-steps module and shared with the server catalog
// preview so the two surfaces cannot drift.

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
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
    <div className="bg-bg flex h-full flex-col overflow-hidden">
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
      // A malformed plan must NOT brick the gate: fall back to a blank decision
      // so the human still gets a Continue button and the run can proceed
      // best-effort rather than parking forever on an open gate it can't satisfy.
      const decisionValue = decision.status === "ok" ? decision.value : {};
      return (
        <Clarify
          decision={decisionValue}
          connected={connected}
          pending={signalPending}
          onSubmit={(answers) => onSignal("clarification", { answers })}
        />
      );
    }
    if (gate === "review") {
      const drafts = parseExecutorOutputs(stepOutputs.execute);
      if (drafts.status === "pending")
        return <Placeholder label="Carrying out the plan…" />;
      if (drafts.status === "malformed")
        return <ErrorLine label="Couldn't read the drafts." />;
      // Distinguish "still reviewing" from "review absent/unreadable" so the
      // panel doesn't silently drop the agent's verdicts (they land after the
      // drafts). reviewPending keeps the human informed a verdict is coming.
      const reviewDecoded = parseReview(stepOutputs.reviewArtifacts);
      const review = reviewDecoded.status === "ok" ? reviewDecoded.value : null;
      const reviewPending = reviewDecoded.status === "pending";
      return (
        <Review
          key={drafts.value.map((a) => a.type).join(",")}
          drafts={drafts.value}
          review={review}
          reviewPending={reviewPending}
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
      const taskDecoded = parseSelectedTaskId(stepOutputs.selectTask);
      // A parse FAILURE on the write-back locators is not the same as "nothing
      // to sync" — surface it as an error on this destructive gate instead of
      // the calm no-op copy that would hide a broken read of the task/record.
      if (
        recordDecoded.status === "malformed" ||
        taskDecoded.status === "malformed"
      )
        return <ErrorLine label="Couldn't read the task details to sync." />;
      const record = recordDecoded.status === "ok" ? recordDecoded.value : null;
      const taskId = taskDecoded.status === "ok" ? taskDecoded.value : null;
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
        <p className="text-text-3 text-sm">Drafts saved to your library.</p>
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

function verdictBadge(verdict: "pass" | "revise" | "reject"): {
  label: string;
  className: string;
} {
  if (verdict === "pass") return { label: "approved", className: "text-green" };
  if (verdict === "reject") return { label: "rejected", className: "text-red" };
  return { label: "needs changes", className: "text-orange" };
}

function Review(props: {
  drafts: GeneratedArtifact[];
  review: ParsedReview | null;
  reviewPending: boolean;
  connected: boolean;
  pending: boolean;
  onSubmit: (approved: GeneratedArtifact[]) => void;
}): ReactNode {
  const known = useMemo(() => new Set<string>(attioTaskArtifactKinds), []);
  const reviewed = useMemo(
    () => mergeReview(props.drafts, props.review),
    [props.drafts, props.review],
  );
  const [selected, setSelected] = useState<Set<number>>(() =>
    defaultSelectedIndices(reviewed, props.review !== null),
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
      {props.reviewPending ? (
        <p className="text-text-3 text-sm">
          The agent is reviewing the drafts…
        </p>
      ) : props.review?.overall ? (
        <p className="text-text-2 text-sm">{props.review.overall}</p>
      ) : null}
      {props.drafts.length === 0 ? (
        <p className="text-text-3 text-sm">
          The plan produced no drafts — nothing to save here.
        </p>
      ) : null}
      {reviewed.map((r, i) => {
        const badge = r.verdict ? verdictBadge(r.verdict) : null;
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
                <span className="text-text font-medium">{r.draft.title}</span>{" "}
                <span className="text-text-3 text-xs">
                  {known.has(r.draft.type)
                    ? r.draft.type
                    : `${r.draft.type} (new type)`}
                </span>
                {badge ? (
                  <span className={`ml-1 text-xs ${badge.className}`}>
                    · {badge.label}
                  </span>
                ) : null}
              </span>
            </span>
            {r.notes && r.verdict !== "pass" ? (
              <span className="text-text-3 pl-6 text-xs">{r.notes}</span>
            ) : null}
          </label>
        );
      })}
      <Button
        disabled={disabled || selected.size === 0}
        onClick={() =>
          props.onSubmit(props.drafts.filter((_, i) => selected.has(i)))
        }
      >
        Save selected ({selected.size})
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
              Attach and complete
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
