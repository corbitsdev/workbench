import {
  action,
  awaitSignal,
  defineWorkflow,
  gate,
  sleep,
  step,
} from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import {
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
  canonicalizeStepToolName,
  canonicalizeToolNames,
  agentStep,
  STEP_TITLE_TAG,
  withCorbitsVocabulary,
} from "@workbench/agents";
import {
  buildAnalyzeSystemPrompt,
  buildExecutorSystemPrompt,
  buildReviewSystemPrompt,
  buildSuggestSystemPrompt,
} from "./prompts";

// Native `action` handler refs — the tool's canonical (factory-prefixed) name,
// resolved via `canonicalizeStepToolName`'s build-time-checked lookup, so
// a typo'd or manifest-drifted tool name fails the build instead of
// deploying a step nothing can dispatch.
export const LIST_WORKSPACE_MEMBERS_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-list-members",
  "attio_list_workspace_members",
);
export const LIST_TASKS_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-list-tasks",
  "attio_list_tasks",
);
export const GET_TASK_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-fetch-task",
  "attio_get_task",
);
export const CREATE_NOTE_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-write-note",
  "attio_create_note",
);
export const UPDATE_TASK_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-write-complete",
  "attio_update_task",
);
export const PERSIST_PIECES_HANDLER = canonicalizeStepToolName(
  "attio-task-agent-persist",
  "attio_task_agent_persist_pieces",
);

export const label = "Attio Task Agent";
export const description =
  "Pick an Attio task; an agent grounds itself in your CRM and internal context, asks only when it must, then drafts the BD artifacts you need — with your approval before anything is written back.";
export const kind = "attio-task-agent";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

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
//   listMembers   action                 attio_list_workspace_members (native primitive)
//   selectMember  awaitSignal            member-selection    → {assignee}
//   listTasks     action                 attio_list_tasks    scoped to assignee (native primitive)
//   selectTask    awaitSignal            task-selection      → {taskId}
//   fetchTask     action                 attio_get_task      from selectTask (native primitive)
//   analyze       step({agent})   PLANNER: ReAct read-only  → AttioAnalyzeDecision (draftActions[] + proposedTaskUpdate?)
//   clarify       awaitSignal            clarification       → {answers?}
//   execute       agentStep  EXECUTOR: performs every draftAction → {outputs:[{type,title,content,brief}]}
//   reviewArtifacts agentStep  REVIEWER: validates outputs vs briefs → {overall, items:[{type,verdict,notes}]}
//   review        awaitSignal            review              → {approvedPieces:[{type,title,content}]}
//   persist       action  artifact_create batch tool  over approvedPieces (native primitive, see note below)
//   suggest       agentStep    merge fetch+analyze → completion summary + follow-ups
//   approveSync   awaitSignal            sync-approval       → {confirm,taskId,parentObject,parentRecordId,note}
//   syncGate      gate on confirm        → writeNote | skipWriteBack
//   writeNote     action                 attio_create_note   FATAL (loud on real Attio errors), native primitive
//   writeComplete action                 attio_update_task   FATAL, after writeNote, native primitive
//
// persist folds into one native `action` dispatching a workflow-owned batch
// tool (`persist-tool.ts`) that loops over `approvedPieces` in-process — the
// pattern `granola_spawn_call_runs` established. Not a mechanical migration
// of the old `deterministicToolStep` map inner step: `MapPrimitive.step` is
// typed `StepPrimitive`, not `Primitive`, so an `action` could never host it
// directly; the fold sidesteps that entirely by moving the iteration into
// the tool. Fatal by design (unchanged): any failed save fails the run, and
// folding N per-item steps into one action means a crash mid-save re-runs
// the WHOLE batch on resume instead of resuming after the already-saved
// pieces — a real checkpointing change, acceptable given an approved batch
// is small.
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
const executeStep = agentStep({
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

const reviewStep = agentStep({
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
    // Native `action`: the tool takes no required args, so `input: { literal: {} }`
    // is the whole call — no reshape needed (mirrors pain-point-collateral's
    // `intake` step and replaces the old empty-argMap workaround, CL-2658).
    listMembers: action({
      handler: LIST_WORKSPACE_MEMBERS_HANDLER,
      input: { literal: {} },
      effect: { requires: [LIST_WORKSPACE_MEMBERS_HANDLER] },
    }),

    selectMember: awaitSignal({
      name: "member-selection",
      after: ["listMembers"],
    }),

    // 1. List the selected member's open tasks. `attio_list_tasks` takes
    // `assignee` (present on the signal payload verbatim) and `isCompleted`
    // (a workflow-authored constant); merge the signal output with a literal
    // to compose the tool's args in one selector — no rename needed, since
    // the selector vocabulary can only pick/merge fields, never rename one.
    listTasks: action({
      handler: LIST_TASKS_HANDLER,
      input: {
        merge: [
          { from: "steps.selectMember.output" },
          { literal: { isCompleted: false } },
        ],
      },
      effect: { requires: [LIST_TASKS_HANDLER] },
      after: ["selectMember"],
    }),

    selectTask: awaitSignal({ name: "task-selection", after: ["listTasks"] }),

    // `selectTask`'s signal payload is already shaped `{ taskId }`, matching
    // `attio_get_task`'s sole required arg — passed through verbatim.
    fetchTask: action({
      handler: GET_TASK_HANDLER,
      input: { from: "steps.selectTask.output" },
      effect: { requires: [GET_TASK_HANDLER] },
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

    persist: action({
      handler: PERSIST_PIECES_HANDLER,
      input: { from: "steps.review.output" },
      effect: { requires: [PERSIST_PIECES_HANDLER] },
      after: ["review"],
    }),

    suggest: agentStep({
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

    // The panel emits parentObject/parentRecordId/content/idempotencyKey
    // directly (idempotencyKey duplicates taskId so a re-run of the SAME
    // task after a mid-write-back failure dedupes instead of creating a
    // second note) — the signal payload already is attio_create_note's
    // arguments verbatim, no reshape needed.
    writeNote: action({
      handler: CREATE_NOTE_HANDLER,
      input: { from: "steps.approveSync.output" },
      effect: { requires: [CREATE_NOTE_HANDLER] },
      after: ["syncGate"],
    }),

    // `attio_update_task` only reads `taskId`/`isCompleted`/`deadlineAt`; the
    // extra approveSync fields (confirm/parentObject/parentRecordId/content)
    // are harmless passengers but `project` keeps the call's args to exactly
    // what the tool expects — `taskId` picked from the signal payload, merged
    // with the workflow-authored `isCompleted: true` constant.
    writeComplete: action({
      handler: UPDATE_TASK_HANDLER,
      input: {
        merge: [
          {
            project: { from: "steps.approveSync.output" },
            fields: ["taskId"],
          },
          { literal: { isCompleted: true } },
        ],
      },
      effect: { requires: [UPDATE_TASK_HANDLER] },
      after: ["writeNote"],
    }),

    // Declining the write-back is a no-op leaf — a sleep, not an LLM call
    // (a decline is not reasoning; matches the per-kind skip leaves).
    skipWriteBack: sleep({ duration: 0, after: ["syncGate"] }),
  },
});
