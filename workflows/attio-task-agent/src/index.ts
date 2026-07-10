import {
  awaitSignal,
  defineWorkflow,
  gate,
  map,
  sleep,
  step,
} from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import {
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
  canonicalizeToolNames,
  deterministicToolStep,
  inlineInferenceStep,
  STEP_TITLE_TAG,
  withCorbitsVocabulary,
} from "@workbench/agents";
import {
  buildAnalyzeSystemPrompt,
  buildExecutorSystemPrompt,
  buildReviewSystemPrompt,
  buildSuggestSystemPrompt,
} from "./prompts";

export const label = "Attio Task Agent";
export const description =
  "Pick an Attio task; an agent grounds itself in your CRM and internal context, asks only when it must, then drafts the BD artifacts you need — with your approval before anything is written back.";
export const kind = "attio-task-agent";

// -------------------------------------------------------------------------
// The gather/analyze agent — the one tool-using reasoning step.
//
// It runs as a full `step({ agent })` (tool-capable harness): a ReAct turn that
// grounds itself with READ-ONLY tools, then returns an AttioAnalyzeDecision.
// The write tools (attio_update_task / attio_create_note) are DELIBERATELY
// excluded here — the agent must never mutate Attio. Write-back happens only in
// the deterministic steps after the human approval gate.
// -------------------------------------------------------------------------

export const GROUNDING_TOOLS = [
  "attio_get_task",
  "attio_get_record",
  "attio_query_records",
  "attio_search_records",
  "attio_list_objects",
  "attio_list_workspace_members",
  "granola_list_notes",
  "granola_get_note",
  "exa_search",
  "artifact_read",
  "artifact_list",
  "artifact_find_by_title",
] as const;

const analyzeAgent = defineAgent({
  id: "attio-task-agent-analyze",
  description:
    "The planner: grounds itself in the Attio task + record and internal context (read-only), then decides the action plan.",
  systemPrompt: withCorbitsVocabulary(buildAnalyzeSystemPrompt()),
  tools: [],
  capabilities: canonicalizeToolNames([...GROUNDING_TOOLS]),
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: {
    credentialName: LLM_CREDENTIAL_NAME,
    [STEP_TITLE_TAG]: "Plan the work",
  },
});

// -------------------------------------------------------------------------
// Workflow graph
//
//   listMembers   deterministicToolStep  attio_list_workspace_members
//   selectMember  awaitSignal            member-selection    → {assignee}
//   listTasks     deterministicToolStep  attio_list_tasks    scoped to assignee
//   selectTask    awaitSignal            task-selection      → {taskId}
//   fetchTask     deterministicToolStep  attio_get_task      from selectTask
//   analyze       step({agent})   PLANNER: ReAct read-only  → AttioAnalyzeDecision (draftActions[] + proposedTaskUpdate?)
//   clarify       awaitSignal            clarification       → {answers?}
//   execute       inlineInferenceStep  EXECUTOR: performs every draftAction → {outputs:[{type,title,content,brief}]}
//   reviewArtifacts inlineInferenceStep  REVIEWER: validates outputs vs briefs → {overall, items:[{type,verdict,notes}]}
//   review        awaitSignal            review              → {approvedPieces:[{type,title,content}]}
//   persist       map artifact_create    over approvedPieces
//   suggest       inlineInferenceStep    merge fetch+analyze → completion summary + follow-ups
//   approveSync   awaitSignal            sync-approval       → {confirm,taskId,parentObject,parentRecordId,note}
//   syncGate      gate on confirm        → writeNote | skipWriteBack
//   writeNote     deterministicToolStep  attio_create_note   FATAL (loud on real Attio errors)
//   writeComplete deterministicToolStep  attio_update_task   FATAL, after writeNote
//
// The pipeline is planner → executor → reviewer → human: the agent decides and
// performs the plan; the human no longer hand-picks actions. Destructive Attio
// write-back is the one action that stays behind an explicit human approval
// (approveSync). Clarify is a light HITL checkpoint; the panel shows the
// planner's questions when status is need_clarification, else a confirm. The
// ReAct planner gathers autonomously, so most runs need no clarification.
//
// Write-back is human-gated on an explicit `confirm` flag (syncGate) and the
// writes are FATAL — a real Attio failure fails the run loudly rather than being
// swallowed. Note-first ordering: if writeComplete fails after writeNote, the
// task stays visibly open (not "done but empty"). writeNote passes the task id
// as its idempotencyKey, so re-running the same task dedupes the note instead of
// creating a duplicate.
// -------------------------------------------------------------------------

const persistStep = deterministicToolStep({
  id: "attio-task-agent-persist",
  title: "Save each piece",
  tool: "artifact_create",
  input: { from: "trigger.payload" },
  // The artifact `kind` is the planner's action `type`. This is INTENTIONALLY
  // free-form (CL-2664): the action registry is open, so a new action type
  // persists as its own artifact kind with no schema change. The artifact table's
  // kind column is a plain string; unknown types are surfaced (not blocked) — the
  // Review panel labels an unrecognized type "(new type)" so a hallucinated kind
  // is visible to the human before they save it, rather than silently rejected.
  argMap: {
    title: { from: "title" },
    kind: { from: "type" },
    content: { from: "content" },
  },
});

// Execution + review, as two agent steps (CL-2664).
//
// The map runtime can only fan out over a STRUCTURED array at a selectable path
// — an awaitSignal payload — never over an agent/inference output (those arrive
// as a `{ reply: "<json>" }` text envelope a selector can't index into). So the
// executor is a SINGLE inline step that reads the planner's whole plan and
// performs every draft action in one turn, emitting `{ outputs: [...] }`; the
// reviewer is a single inline step that validates that array. This keeps the
// plan agent-decided end to end — no human gate is inserted to structure it.
//
// `execute` sees the plan (analyze) + task (fetchTask) + any clarification;
// their envelope keys (reply / content / answers) don't collide, so the merge is
// lossless. `review` reads only `execute.output` — each produced item echoes its
// brief, so the reviewer judges against the exact instruction with no join.
const executeStep = inlineInferenceStep({
  id: "attio-task-agent-execute",
  title: "Do the work",
  systemPrompt: buildExecutorSystemPrompt(),
  model: LLM_WRITER_MODEL,
  maxTokens: 16384,
  input: {
    merge: [
      { from: "steps.analyze.output" },
      { from: "steps.fetchTask.output" },
      { from: "steps.clarify.output" },
    ],
  },
  after: ["clarify"],
});

const reviewStep = inlineInferenceStep({
  id: "attio-task-agent-review-artifacts",
  title: "Check the drafts",
  systemPrompt: buildReviewSystemPrompt(),
  input: { from: "steps.execute.output" },
  // Bounded so a long batch can't run the judge unboundedly; a truncated review
  // degrades gracefully (the UI tolerates a null/partial review) rather than
  // dead-ending like a truncated executor would.
  maxTokens: 8192,
  after: ["execute"],
});

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 0. Resolve whose tasks to work — list workspace members, then pick one.
    //    The UI defaults to the member saved on the account (MemberPreferences
    //    .attioMemberId) and auto-submits when present, so returning users skip
    //    it; it stays switchable to work another member's tasks.
    listMembers: deterministicToolStep({
      id: "attio-task-agent-list-members",
      title: "List workspace members",
      tool: "attio_list_workspace_members",
      // First step with no `input` selector: the sidecar supervisor otherwise
      // hands it the run's (string) trigger payload as tool args, which the
      // step-tool-harness rejects. attio_list_workspace_members takes no args,
      // so pin the arguments to {} with an empty argMap (CL-2658).
      argMap: {},
    }),

    selectMember: awaitSignal({
      name: "member-selection",
      after: ["listMembers"],
    }),

    // 1. List the selected member's open tasks.
    listTasks: deterministicToolStep({
      id: "attio-task-agent-list-tasks",
      title: "List open tasks",
      tool: "attio_list_tasks",
      input: { from: "steps.selectMember.output" },
      argMap: {
        assignee: { from: "assignee" },
        isCompleted: { literal: false },
      },
      after: ["selectMember"],
    }),

    selectTask: awaitSignal({ name: "task-selection", after: ["listTasks"] }),

    fetchTask: deterministicToolStep({
      id: "attio-task-agent-fetch-task",
      title: "Load the task",
      tool: "attio_get_task",
      input: { from: "steps.selectTask.output" },
      argMap: { taskId: { from: "taskId" } },
      after: ["selectTask"],
    }),

    analyze: step({
      agent: analyzeAgent,
      input: {
        merge: [
          { from: "steps.fetchTask.output" },
          { from: "steps.selectTask.output" },
        ],
      },
      after: ["fetchTask"],
    }),

    clarify: awaitSignal({ name: "clarification", after: ["analyze"] }),

    // The executor performs the planner's draft actions (no human kind-picker —
    // the agent decided the plan). Single step over the whole plan; see
    // executeStep for why this is not a map.
    execute: executeStep,

    // The reviewer validates the produced outputs against their briefs before
    // the human sees them.
    reviewArtifacts: reviewStep,

    review: awaitSignal({ name: "review", after: ["reviewArtifacts"] }),

    persist: map({
      over: { from: "steps.review.output.approvedPieces" },
      step: persistStep,
      after: ["review"],
    }),

    suggest: inlineInferenceStep({
      id: "attio-task-agent-suggest",
      title: "Suggest follow-ups",
      systemPrompt: buildSuggestSystemPrompt(),
      input: {
        merge: [
          { from: "steps.fetchTask.output" },
          { from: "steps.analyze.output" },
        ],
      },
      after: ["persist"],
    }),

    approveSync: awaitSignal({ name: "sync-approval", after: ["suggest"] }),

    // Write-back is human-gated on an explicit `confirm` flag — NOT on a
    // swallowed validation error. Confirming means "attach the approved output
    // as a note AND mark the task complete"; the writes are FATAL so a real
    // Attio failure (403/500) fails the run loudly instead of the user believing
    // a note landed when it didn't. Declining routes to a no-op leaf. The ids
    // (taskId, parentObject, parentRecordId) are assembled by the panel from
    // prior step state, not typed by the human.
    syncGate: gate({
      when: { from: "steps.approveSync.output.confirm" },
      then: "writeNote",
      else: "skipWriteBack",
      after: ["approveSync"],
    }),

    writeNote: deterministicToolStep({
      id: "attio-task-agent-write-note",
      title: "Post the note to Attio",
      tool: "attio_create_note",
      input: { from: "steps.approveSync.output" },
      argMap: {
        parentObject: { from: "parentObject" },
        parentRecordId: { from: "parentRecordId" },
        content: { from: "note" },
        // Key the note by the task id so a re-run of the SAME task after a
        // mid-write-back failure dedupes instead of creating a second note.
        idempotencyKey: { from: "taskId" },
      },
      after: ["syncGate"],
    }),

    writeComplete: deterministicToolStep({
      id: "attio-task-agent-write-complete",
      title: "Mark the task complete",
      tool: "attio_update_task",
      input: { from: "steps.approveSync.output" },
      argMap: {
        taskId: { from: "taskId" },
        isCompleted: { literal: true },
      },
      after: ["writeNote"],
    }),

    // Declining the write-back is a no-op leaf — a sleep, not an LLM call
    // (a decline is not reasoning; matches the per-kind skip leaves).
    skipWriteBack: sleep({ duration: 0, after: ["syncGate"] }),
  },
});
