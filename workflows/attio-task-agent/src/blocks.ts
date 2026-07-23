/**
 * The attio-task-agent workflow's own dock blocks (CL-2731).
 *
 * The second workflow migrated off the bespoke `ui.tsx` panel onto the shared
 * UIBlock surface (after ab-compare-hitl, CL-2683). This builder derives the
 * run's dock content — a progress block plus the active gate's affordance —
 * from the run's log-derived state and its decoded step outputs, reusing the
 * exact same pure decoders the fallback panel uses (`./parse`), so the dock
 * preview and the panel can never disagree about what a step produced.
 *
 * Two of the five gates are single-value selections the dock can collect inline:
 *   - member-selection → a `choice` over the workspace members (pick the assignee)
 *   - task-selection   → a `choice` over the member's open tasks (pick the task)
 * A third folds a free-text answer:
 *   - clarification    → a `choice` with a `promptBox`, folded into `answers`
 *
 * The `sync-approval` gate — the one DESTRUCTIVE gate — is block-driven as a
 * pair of choices (CL-2684): a confirm choice carrying `{ confirm: true }` plus
 * the write locators and a required note prompt-box, and a separate skip choice
 * carrying `{ confirm: false }`. See syncApprovalBlocks for why a choice, not a
 * form, is the safe primitive here (a form field cannot express a real boolean).
 *
 * The `review` gate stays a run-page `link` (the strangler): it must emit the
 * selected drafts as full content-bearing objects (`approvedPieces`, which the
 * persist map iterates), and neither the form nor the multiSelect block can
 * carry an array of arbitrary objects filtered from a known list through the
 * verbatim-payload seam — so it is deferred to the run-page panel.
 *
 * Review lessons carried from CL-2683: the action affordance (the choice) is the
 * only orange surface — passive/awaiting states render as text/link/error, never
 * an actionable-looking control; option headlines are the human member/task name
 * (the raw id rides as secondary text); and when the options aren't resolvable
 * (still loading, unreadable, or empty) the dock emits a run-page link rather
 * than an empty choice.
 */
import {
  gateFallbackBlock,
  pendingGateForRun,
  progressStateForStepPhase,
  runPageRedirectBlock,
  type DockRunInput,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import {
  parseDecision,
  parseFirstLinkedRecord,
  parseMembers,
  parseSelectedTaskId,
  parseTasks,
} from "./parse";

/** The awaitSignal gate names (match the workflow def in ./index.ts). */
export const MEMBER_SELECTION_SIGNAL = "member-selection";
export const TASK_SELECTION_SIGNAL = "task-selection";
export const CLARIFICATION_SIGNAL = "clarification";
export const REVIEW_SIGNAL = "review";
export const SYNC_APPROVAL_SIGNAL = "sync-approval";

export interface AttioTaskAgentBlockInput extends DockRunInput {
  /**
   * Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces
   * (the value is the step's output, NOT wrapped in `{ output }`).
   */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

// The step that PRODUCES a gate's options is a distinct earlier step (e.g.
// `listMembers` feeds the `member-selection` gate). A "pending" decode means its
// output is absent — but that has two very different causes: the producing step
// is still in-flight (genuinely loading), or it already terminated and its
// output is a blob ref `stepOutputsFromLog` omitted / couldn't read. Only the
// former is a transient "Loading…"; the latter is a permanent dead-end that must
// send the human to the run page (the documented escape), never a forever-spinner.
function sourceStepStillRunning(
  input: AttioTaskAgentBlockInput,
  sourceStepId: string,
): boolean {
  const source = input.steps.find((step) => step.stepId === sourceStepId);
  // No such step in the log yet → treat as still-running (it will appear).
  if (source === undefined) return true;
  return source.phase === "in-flight";
}

// A gate whose options aren't resolvable in the dock (unreadable or genuinely
// empty) never renders an actionable choice — the human is sent to the run page
// instead of a dead control (CL-2683 lesson).
function memberSelectionBlock(input: AttioTaskAgentBlockInput): UIBlock {
  const members = parseMembers(input.stepOutputs.listMembers);
  if (
    members.status === "pending" &&
    sourceStepStillRunning(input, "listMembers")
  ) {
    return { kind: "text", text: "Loading workspace members…" };
  }
  if (members.status !== "ok" || members.value.length === 0) {
    return gateFallbackBlock({
      runId: input.runId,
      producingStepId: "listMembers",
      steps: input.steps,
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
      dataStatus: members.status === "ok" ? "empty" : "unavailable",
      emptyMessage: "No workspace members are available to assign.",
      unavailableTitle: "Open the run to pick a member",
      unavailableDescription:
        "The member list is too large to load here — choose on the run page.",
    });
  }
  return {
    kind: "choice",
    prompt: "Whose tasks do you want to work?",
    signalName: MEMBER_SELECTION_SIGNAL,
    options: members.value.map((member) => ({
      id: member.assignee,
      label: member.label,
      value: member.assignee,
      // The raw assignee (email / member id) rides as secondary text when it is
      // not already the headline — the human name leads (CL-2683 lesson).
      ...(member.label !== member.assignee
        ? { description: member.assignee }
        : {}),
      payload: { assignee: member.assignee },
    })),
  };
}

function taskSelectionBlock(input: AttioTaskAgentBlockInput): UIBlock {
  const tasks = parseTasks(input.stepOutputs.listTasks);
  if (
    tasks.status === "pending" &&
    sourceStepStillRunning(input, "listTasks")
  ) {
    return { kind: "text", text: "Loading open tasks…" };
  }
  if (tasks.status !== "ok" || tasks.value.length === 0) {
    return gateFallbackBlock({
      runId: input.runId,
      producingStepId: "listTasks",
      steps: input.steps,
      ...(input.surface !== undefined ? { surface: input.surface } : {}),
      dataStatus: tasks.status === "ok" ? "empty" : "unavailable",
      emptyMessage: "No open tasks are available for this member.",
      unavailableTitle: "Open the run to pick a task",
      unavailableDescription:
        "The task list is too large to load here — choose on the run page.",
    });
  }
  return {
    kind: "choice",
    prompt: "Pick a task to work.",
    signalName: TASK_SELECTION_SIGNAL,
    options: tasks.value.map((task) => ({
      id: task.taskId,
      // The task content is the headline; the id/deadline is secondary text.
      label: task.label,
      value: task.taskId,
      ...(task.deadline !== undefined
        ? { description: `Due ${task.deadline.slice(0, 10)}` }
        : {}),
      payload: { taskId: task.taskId },
    })),
  };
}

// The clarification gate: a single Continue option with a free-text prompt-box
// folded into `answers`. When the planner asked questions they lead the prompt;
// otherwise it's a light "add anything, or continue" checkpoint (most runs need
// no clarification, so an empty continue must be valid — payload defaults to {}).
function clarificationBlock(input: AttioTaskAgentBlockInput): UIBlock {
  const decision = parseDecision(input.stepOutputs.analyze);
  if (decision.status === "pending") {
    return { kind: "text", text: "Analyzing the task…" };
  }
  const value = decision.status === "ok" ? decision.value : {};
  const questions = value.questions ?? [];
  const needsInput = value.status === "need_clarification";
  const promptParts: string[] = [];
  if (value.reasoning !== undefined && value.reasoning.length > 0) {
    promptParts.push(value.reasoning);
  }
  if (questions.length > 0) {
    promptParts.push(questions.map((q) => `• ${q}`).join("\n"));
  }
  if (promptParts.length === 0) {
    promptParts.push(
      needsInput
        ? "The agent needs more detail to continue."
        : "Add anything the agent should know, or continue.",
    );
  }
  return {
    kind: "choice",
    prompt: promptParts.join("\n\n"),
    signalName: CLARIFICATION_SIGNAL,
    promptBox: {
      placeholder: needsInput
        ? "Add the missing detail…"
        : "Add anything the agent should know (optional)…",
      payloadKey: "answers",
    },
    options: [{ id: "continue", label: "Continue", value: "", payload: {} }],
  };
}

// The sync-approval gate is the ONE destructive gate: confirming attaches a
// note to the linked Attio record and marks the task complete. It is migrated
// to a pair of CHOICE blocks, not a form (CL-2684): a form field cannot express
// a real boolean, and a string "false" is truthy — it would fire the write-back
// the `syncGate` branches on. A choice carries a verbatim boolean + the write
// locators in each option's payload, so the safety invariant is structural:
//   - "Attach and complete" is a SEPARATE choice whose payload is
//     `{ confirm: true, taskId, parentObject, parentRecordId }` (locators read
//     from prior step state, never typed), with a REQUIRED prompt-box that folds
//     the mandatory note under `note` — the button holds until the note is
//     non-empty, so an empty/unconfirmed submit can never fire the write.
//   - "Skip" is a separate choice whose payload is `{ confirm: false }`.
// The /resume boundary (SyncApprovalPayloadSchema) independently rejects a
// confirm missing any locator or the note, so neither the dock nor a replayed
// request can drive a hollow write-back. When the locators are unresolvable the
// dock never offers a confirm — only a skip (or an error), mirroring the panel.
function syncApprovalBlocks(input: AttioTaskAgentBlockInput): UIBlock[] {
  const recordDecoded = parseFirstLinkedRecord(input.stepOutputs.fetchTask);
  const taskDecoded = parseSelectedTaskId(input.stepOutputs.selectTask);
  const failedProducer = input.steps.find(
    (step) =>
      (step.stepId === "fetchTask" || step.stepId === "selectTask") &&
      step.phase === "failed",
  );
  if (failedProducer !== undefined) {
    return [
      gateFallbackBlock({
        runId: input.runId,
        producingStepId: failedProducer.stepId,
        steps: input.steps,
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
        dataStatus: "unavailable",
        emptyMessage: "No linked Attio record to write back to.",
        unavailableTitle: "Complete the write-back on the run page",
        unavailableDescription:
          "The task details couldn't be read here — review and finish the sync on the run page.",
      }),
    ];
  }
  if (
    recordDecoded.status === "malformed" ||
    taskDecoded.status === "malformed"
  ) {
    // A malformed decode strands the user on the destructive gate: the dock
    // can't safely offer the write-back, but the run page can. Send them there
    // rather than dead-ending on an error (CL-2684).
    return [
      { kind: "error", message: "Couldn't read the task details to sync." },
      runPageRedirectBlock(
        input.runId,
        "Complete the write-back on the run page",
        "The task details couldn't be read here — review and finish the sync on the run page.",
        input.surface,
      ),
    ];
  }

  const skip: UIBlock = {
    kind: "choice",
    signalName: SYNC_APPROVAL_SIGNAL,
    options: [
      {
        id: "skip",
        label: "Skip the write-back",
        value: "skip",
        payload: { confirm: false },
      },
    ],
  };

  const record = recordDecoded.status === "ok" ? recordDecoded.value : null;
  const taskId = taskDecoded.status === "ok" ? taskDecoded.value : null;
  if (record === null || taskId === null) {
    // Nothing to write back to — offer only the no-op, never a confirm with
    // missing locators (which the boundary would reject anyway).
    return [
      {
        kind: "text",
        text: "No linked Attio record to write back to — nothing to sync.",
      },
      skip,
    ];
  }

  const decision = parseDecision(input.stepOutputs.analyze);
  const proposedNote =
    decision.status === "ok"
      ? decision.value.proposedTaskUpdate?.note
      : undefined;
  const confirm: UIBlock = {
    kind: "choice",
    prompt: `Attach a note to the ${record.object} record ${record.recordId} and mark the task complete.`,
    signalName: SYNC_APPROVAL_SIGNAL,
    promptBox: {
      placeholder:
        proposedNote !== undefined && proposedNote.length > 0
          ? `Suggested: ${proposedNote}`
          : "The note to attach to the record…",
      payloadKey: "content",
      required: true,
    },
    options: [
      {
        id: "attach-and-complete",
        label: "Attach and complete",
        value: "confirm",
        payload: {
          confirm: true,
          taskId,
          // Duplicated as idempotencyKey: attio_create_note keys retries by
          // it, attio_update_task by taskId — the write-back steps read this
          // payload directly with no argMap.
          idempotencyKey: taskId,
          parentObject: record.object,
          parentRecordId: record.recordId,
        },
      },
    ],
  };
  return [confirm, skip];
}

export function buildAttioTaskAgentBlocks(
  input: AttioTaskAgentBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    if (gate.signalName === MEMBER_SELECTION_SIGNAL) {
      blocks.push(memberSelectionBlock(input));
    } else if (gate.signalName === TASK_SELECTION_SIGNAL) {
      blocks.push(taskSelectionBlock(input));
    } else if (gate.signalName === CLARIFICATION_SIGNAL) {
      blocks.push(clarificationBlock(input));
    } else if (gate.signalName === REVIEW_SIGNAL) {
      // The review gate edits + selects the approved drafts — a multi-field form
      // the choice block can't collect. Send the human to the run page's panel
      // (full block-driven review is CL-2715).
      blocks.push(
        runPageRedirectBlock(
          input.runId,
          "Review the drafts on the run page",
          "Choose which drafts to save on the run page — the dock can't edit them yet.",
          input.surface,
        ),
      );
    } else if (gate.signalName === SYNC_APPROVAL_SIGNAL) {
      // The DESTRUCTIVE write-back confirmation, now block-driven as a pair of
      // choices (CL-2684) — see syncApprovalBlocks for the safety invariant.
      blocks.push(...syncApprovalBlocks(input));
    } else {
      // An unknown gate the dock can't collect — send the human to the run page
      // rather than inventing an affordance (CL-2683 lesson).
      blocks.push(
        runPageRedirectBlock(
          input.runId,
          "Continue on the run page",
          "This run needs input the dock can't collect yet — continue on the run page.",
          input.surface,
        ),
      );
    }
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}
