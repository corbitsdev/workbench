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
 * The other two gates (`review`, `sync-approval`) are multi-field FORMS the
 * choice block cannot yet collect — emitting a generic "Continue" choice would
 * POST an empty payload and corrupt the run. They get a run-page `link` instead
 * (the strangler, like ab-compare-hitl's config gate); full block-driven forms
 * are CL-2715.
 *
 * Review lessons carried from CL-2683: the action affordance (the choice) is the
 * only orange surface — passive/awaiting states render as text/link/error, never
 * an actionable-looking control; option headlines are the human member/task name
 * (the raw id rides as secondary text); and when the options aren't resolvable
 * (still loading, unreadable, or empty) the dock emits a run-page link rather
 * than an empty choice.
 */
import {
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import { parseDecision, parseMembers, parseTasks } from "./parse";

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

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
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
  if (members.status === "pending") {
    if (sourceStepStillRunning(input, "listMembers")) {
      return { kind: "text", text: "Loading workspace members…" };
    }
    // The producing step is terminal but its output isn't client-resolvable
    // (blob-omitted / unreadable) — a run-page link, not a perpetual spinner.
    return runPageLink(
      input.runId,
      "Open the run to pick a member",
      "The member list is too large to load here — choose on the run page.",
    );
  }
  if (members.status === "malformed") {
    return { kind: "error", message: "Couldn't load workspace members." };
  }
  if (members.value.length === 0) {
    return runPageLink(
      input.runId,
      "Open the run to pick a member",
      "No workspace members are available here — choose on the run page.",
    );
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
  if (tasks.status === "pending") {
    if (sourceStepStillRunning(input, "listTasks")) {
      return { kind: "text", text: "Loading open tasks…" };
    }
    return runPageLink(
      input.runId,
      "Open the run to pick a task",
      "The task list is too large to load here — choose on the run page.",
    );
  }
  if (tasks.status === "malformed") {
    return { kind: "error", message: "Couldn't load the task list." };
  }
  if (tasks.value.length === 0) {
    return runPageLink(
      input.runId,
      "Open the run to pick a task",
      "No open tasks are available here — choose on the run page.",
    );
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
        runPageLink(
          input.runId,
          "Review the drafts on the run page",
          "Choose which drafts to save on the run page — the dock can't edit them yet.",
        ),
      );
    } else if (gate.signalName === SYNC_APPROVAL_SIGNAL) {
      // Write-back confirmation carries a note + record locators — a form, and a
      // DESTRUCTIVE one. Never collect it with a generic choice; run page only.
      blocks.push(
        runPageLink(
          input.runId,
          "Confirm the Attio write-back on the run page",
          "Approve attaching the note and completing the task on the run page.",
        ),
      );
    } else {
      // An unknown gate the dock can't collect — send the human to the run page
      // rather than inventing an affordance (CL-2683 lesson).
      blocks.push(
        runPageLink(
          input.runId,
          "Continue on the run page",
          "This run needs input the dock can't collect yet — continue on the run page.",
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
