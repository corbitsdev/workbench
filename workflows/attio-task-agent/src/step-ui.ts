// Declarative step -> UI map (see `packages/workbench-shared/src/step-ui.ts`
// for the full contract this shape mirrors) — colocated with the workflow's
// step definitions instead of a hand-written `blocks.ts`/`ui.tsx`. `StepUIMap`
// below is a local, structural mirror of that package's `StepUI`/`StepUIEntry`
// types (types only — no runtime import), so this workflow package carries no
// dependency on `@workbench/shared` at all; the host-side derivation
// (`blocksFromStepUI` in `@workbench/blocks`) validates the map structurally
// when it consumes it.
//
// Gate → block, every one DATA-DRIVEN (gateFromOutput + gateSourceStep) —
// each source step is this workflow's own gate-prep tool (see `./tools.ts`),
// never a hand-written per-workflow `blocks.ts` builder:
//   member-selection — memberSelectGate: a `choice` over the workspace
//                       members, or a plain `text` degrade when the list is
//                       empty/unreadable.
//   task-selection   — taskSelectGate: a `choice` over the member's open
//                       tasks, same degrade shape.
//   clarification    — clarifyGate: a `choice` with a free-text `promptBox`
//                       folded into `answers`; always renders (a malformed/
//                       absent decision degrades to a plain continue).
//   review           — reviewGate: a `reviewList` over the executor's drafts
//                       + the reviewer's verdicts, defaulting the pass/no-
//                       review drafts to approved (mirrors the former panel's
//                       `defaultSelectedIndices`). Fatal on the tool's own
//                       side (see tools.ts) if the drafts don't decode — a
//                       genuine contract violation, not a rendering concern.
//   sync-approval    — syncApprovalGate: a `choice` with "Attach and
//                       complete" (carrying the write-back locators) and
//                       "Skip the write-back" — the ONE destructive gate.
export const MEMBER_SELECTION_SIGNAL = "member-selection";
export const TASK_SELECTION_SIGNAL = "task-selection";
export const CLARIFICATION_SIGNAL = "clarification";
export const REVIEW_SIGNAL = "review";
export const SYNC_APPROVAL_SIGNAL = "sync-approval";

interface StepUIEntry {
  role?: "intake" | "review" | "persist" | "display";
  title?: string;
  gateFromOutput?: boolean;
  gateSourceStep?: string;
}

export type StepUIMap = Record<string, StepUIEntry>;

export const STEP_UI: StepUIMap = {
  listMembers: { title: "List workspace members" },
  memberSelectGate: { title: "Prepare member picker" },
  selectMember: {
    role: "intake",
    title: "Whose tasks?",
    gateFromOutput: true,
    gateSourceStep: "memberSelectGate",
  },
  listTasks: { title: "List open tasks" },
  taskSelectGate: { title: "Prepare task picker" },
  selectTask: {
    role: "intake",
    title: "Pick a task",
    gateFromOutput: true,
    gateSourceStep: "taskSelectGate",
  },
  fetchTask: { title: "Fetch the task" },
  analyze: { title: "Plan the work" },
  clarifyGate: { title: "Prepare clarification" },
  clarify: {
    role: "intake",
    title: "Clarify",
    gateFromOutput: true,
    gateSourceStep: "clarifyGate",
  },
  execute: { title: "Do the work" },
  reviewArtifacts: { title: "Check the drafts" },
  reviewGate: { title: "Prepare review" },
  review: {
    role: "review",
    title: "Review",
    gateFromOutput: true,
    gateSourceStep: "reviewGate",
  },
  persist: { role: "persist", title: "Save to workbench" },
  suggest: { title: "Suggest follow-ups" },
  syncApprovalGate: { title: "Prepare write-back approval" },
  approveSync: {
    role: "review",
    title: "Write back to Attio",
    gateFromOutput: true,
    gateSourceStep: "syncApprovalGate",
  },
  writeNote: { title: "Attach the note" },
  writeComplete: { title: "Mark the task complete" },
  skipWriteBack: { title: "Skip write-back" },
};
