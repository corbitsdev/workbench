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
  buildAnalyzeSystemPrompt,
  buildExecutorSystemPrompt,
  buildReviewSystemPrompt,
  buildSuggestSystemPrompt,
} from "./prompts";

export { STEP_UI } from "./step-ui";

// Re-export the user-facing display flow so it travels with the workflow package
// for the server catalog classifier; the client panel imports it from the same
// browser-safe module.
export { DISPLAY_STEPS } from "./display-steps";

// Tag shared with every step class, naming the step in the catalog/run-UI
// preview in place of the humanized step-map key.
const STEP_TITLE_TAG = "workbench.title";

// Corbits terminology guidance every reasoning step's system prompt carries,
// so the model spells Corbits/Corbits.dev/Interchange/Faremeter consistently
// regardless of how the source material spelled them. Formerly applied
// automatically by `@workbench/agents`' `agentStep` sugar; inlined here as a
// plain string join, mirroring every other cutover workflow's own copy.
const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

const LLM_PROVIDER = "openai-compatible";
const LLM_DEFAULT_MODEL = "deepseek-v4-flash";
const LLM_WRITER_MODEL = "kimi-k2.6";

// The reviewer is bounded so a long batch can't run the judge unboundedly; a
// truncated review degrades gracefully (the review gate tolerates a null/
// partial review) rather than dead-ending like a truncated executor would.
const REVIEW_MAX_TOKENS = 8192;
const EXECUTE_MAX_TOKENS = 16384;

export const label = "Attio Task Agent";
export const description =
  "Pick an Attio task; an agent grounds itself in your CRM and internal context, asks only when it must, then drafts the BD artifacts you need — with your approval before anything is written back.";
export const kind = "attio-task-agent";

// -------------------------------------------------------------------------
// Native `action` handler refs — the tool's canonical (factory-prefixed)
// name, checked against the committed tool manifest by a repo-level test
// (`packages/tool-manifest/src/resolvable-handlers.test.ts`), so a typo'd or
// manifest-drifted handler string fails the build instead of deploying a
// step nothing can dispatch.
// -------------------------------------------------------------------------
export const LIST_WORKSPACE_MEMBERS_HANDLER =
  "@workbench/tools-attio/attio:attio_list_workspace_members";
export const LIST_TASKS_HANDLER =
  "@workbench/tools-attio/attio:attio_list_tasks";
export const GET_TASK_HANDLER = "@workbench/tools-attio/attio:attio_get_task";
export const CREATE_NOTE_HANDLER =
  "@workbench/tools-attio/attio:attio_create_note";
export const UPDATE_TASK_HANDLER =
  "@workbench/tools-attio/attio:attio_update_task";
export const PERSIST_PIECES_HANDLER =
  "@workbench/workflow-attio-task-agent/persist:attio_task_agent_persist_pieces";

// This workflow's own gate-prep tools (`./tools.ts`) — each shapes a prior
// step's raw output into the UIBlock its `awaitSignal` gate's STEP_UI entry
// renders via `gateFromOutput`/`gateSourceStep` (`./step-ui.ts`).
export const MEMBER_SELECTION_GATE_HANDLER =
  "@workbench/workflow-attio-task-agent/core:attio_task_agent_member_selection_gate";
export const TASK_SELECTION_GATE_HANDLER =
  "@workbench/workflow-attio-task-agent/core:attio_task_agent_task_selection_gate";
export const CLARIFICATION_GATE_HANDLER =
  "@workbench/workflow-attio-task-agent/core:attio_task_agent_clarification_gate";
export const REVIEW_GATE_HANDLER =
  "@workbench/workflow-attio-task-agent/core:attio_task_agent_review_gate";
export const SYNC_APPROVAL_GATE_HANDLER =
  "@workbench/workflow-attio-task-agent/core:attio_task_agent_sync_approval_gate";

// -------------------------------------------------------------------------
// The gather/analyze agent — the one tool-using reasoning step.
//
// It runs as a full `step({ agent })` (tool-capable harness): a ReAct turn that
// grounds itself with READ-ONLY tools, then returns an AttioAnalyzeDecision.
// The write tools (attio_update_task / attio_create_note) are DELIBERATELY
// excluded here — the agent must never mutate Attio. Write-back happens only in
// the deterministic steps after the human approval gate.
//
// Capabilities are literal canonical `<factoryId>:<bareName>` strings (the
// same shape `resolvable-handlers.test.ts` checks action handlers against),
// not `canonicalizeToolNames([...])` — that helper derives from the
// monorepo-generated committed tool manifest, a dependency this package must
// not carry (installable/runnable on any Interchange hub).
// -------------------------------------------------------------------------

const analyzeAgent = defineAgent({
  id: "attio-task-agent-analyze",
  description:
    "The planner: grounds itself in the Attio task + record and internal context (read-only), then decides the action plan.",
  systemPrompt: [CORBITS_VOCABULARY, buildAnalyzeSystemPrompt()].join("\n\n"),
  tools: [],
  capabilities: [
    "@workbench/tools-attio/attio:attio_get_task",
    "@workbench/tools-attio/attio:attio_get_record",
    "@workbench/tools-attio/attio:attio_query_records",
    "@workbench/tools-attio/attio:attio_search_records",
    "@workbench/tools-attio/attio:attio_list_objects",
    "@workbench/tools-attio/attio:attio_list_workspace_members",
    "@workbench/tools-granola/granola:granola_list_notes",
    "@workbench/tools-granola/granola:granola_get_note",
    "@workbench/tools-exa/exa:exa_search",
    "@workbench/tools-artifact/artifact:artifact_read",
    "@workbench/tools-artifact/artifact:artifact_list",
    "@workbench/tools-artifact/artifact:artifact_find_by_title",
  ],
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: { [STEP_TITLE_TAG]: "Plan the work" },
});

// The executor performs every draftAction in one turn (CL-2664): the map
// runtime can only fan out over a STRUCTURED array at a selectable path — an
// awaitSignal payload — never over an agent/inference output (those arrive
// as a `{ reply: "<json>" }` text envelope a selector can't index into). So
// this is a single inline step reading the planner's whole plan, emitting
// `{ outputs: [...] }`.
const executeAgent = defineAgent({
  id: "attio-task-agent-execute",
  description: "The executor: performs every planned draft action in one turn.",
  systemPrompt: buildExecutorSystemPrompt(),
  tools: [],
  capabilities: [],
  inference: {
    sources: [
      {
        provider: LLM_PROVIDER,
        model: LLM_WRITER_MODEL,
        parameters: { maxTokens: EXECUTE_MAX_TOKENS },
      },
    ],
  },
  tags: { [STEP_TITLE_TAG]: "Do the work" },
});

// The reviewer validates the produced outputs against their briefs before the
// human sees them — a single inline step over the whole executor output.
const reviewAgent = defineAgent({
  id: "attio-task-agent-review-artifacts",
  description:
    "The reviewer: validates every produced output against its brief.",
  systemPrompt: buildReviewSystemPrompt(),
  tools: [],
  capabilities: [],
  inference: {
    sources: [
      {
        provider: LLM_PROVIDER,
        model: LLM_DEFAULT_MODEL,
        parameters: { maxTokens: REVIEW_MAX_TOKENS },
      },
    ],
  },
  tags: { [STEP_TITLE_TAG]: "Check the drafts" },
});

const suggestAgent = defineAgent({
  id: "attio-task-agent-suggest",
  description: "Summarizes the run and proposes follow-ups for the human.",
  systemPrompt: buildSuggestSystemPrompt(),
  tools: [],
  capabilities: [],
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: { [STEP_TITLE_TAG]: "Suggest follow-ups" },
});

// -------------------------------------------------------------------------
// Workflow graph
//
//   listMembers      action        attio_list_workspace_members
//   memberSelectGate action        attio_task_agent_member_selection_gate (gate-prep)
//   selectMember     awaitSignal   member-selection    → {assignee}
//   listTasks        action        attio_list_tasks    scoped to assignee
//   taskSelectGate   action        attio_task_agent_task_selection_gate (gate-prep)
//   selectTask       awaitSignal   task-selection      → {taskId}
//   fetchTask        action        attio_get_task      from selectTask
//   analyze          step({agent}) PLANNER: ReAct read-only → AttioAnalyzeDecision
//   clarifyGate      action        attio_task_agent_clarification_gate (gate-prep)
//   clarify          awaitSignal   clarification       → {answers?}
//   execute          step({agent}) EXECUTOR: every draftAction → {outputs:[...]}
//   reviewArtifacts  step({agent}) REVIEWER: validates outputs vs briefs
//   reviewGate       action        attio_task_agent_review_gate (gate-prep)
//   review           awaitSignal   review              → {approvedPieces:[...]}
//   persist          action        attio_task_agent_persist_pieces  batch, over approvedPieces
//   suggest          step({agent}) merge fetch+analyze → completion summary
//   syncApprovalGate action        attio_task_agent_sync_approval_gate (gate-prep)
//   approveSync      awaitSignal   sync-approval       → {confirm,taskId,parentObject,parentRecordId,content}
//   syncGate         gate on confirm → writeNote | skipWriteBack
//   writeNote        action        attio_create_note   FATAL, native primitive
//   writeComplete    action        attio_update_task   FATAL, after writeNote
//
// Every `awaitSignal` gate is preceded by its own gate-prep `action` step
// (`./tools.ts`), each shaping the upstream data into the UIBlock the gate's
// STEP_UI entry renders via `gateFromOutput`/`gateSourceStep` (`./step-ui.ts`)
// — no hand-written `blocks.ts`/`ui.tsx`.
//
// persist is a native `action` dispatching a workflow-owned batch tool that
// loops over `approvedPieces` in-process (folded from a `map` over
// `artifact_create` — `MapPrimitive.step` is typed `StepPrimitive`, not
// `Primitive`, so an `action` could never host it directly). Fatal by
// design: any failed save fails the run.
//
// The pipeline is planner → executor → reviewer → human: the agent decides and
// performs the plan; the human no longer hand-picks actions. Destructive Attio
// write-back is the one action that stays behind an explicit human approval
// (approveSync). Clarify is a light HITL checkpoint; the gate shows the
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

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    // 0. Resolve whose tasks to work — list workspace members, then pick one.
    // Native `action`: the tool takes no required args, so `input: { literal: {} }`
    // is the whole call — no reshape needed.
    listMembers: action({
      handler: LIST_WORKSPACE_MEMBERS_HANDLER,
      input: { literal: {} },
      effect: { requires: [LIST_WORKSPACE_MEMBERS_HANDLER] },
    }),

    memberSelectGate: action({
      handler: MEMBER_SELECTION_GATE_HANDLER,
      input: { project: { from: "steps" }, fields: ["listMembers"] },
      effect: { requires: [MEMBER_SELECTION_GATE_HANDLER] },
      after: ["listMembers"],
    }),

    selectMember: awaitSignal({
      name: "member-selection",
      after: ["memberSelectGate"],
    }),

    // 1. List the selected member's open tasks. `attio_list_tasks` takes
    // `assignee` (present on the signal payload verbatim) and `isCompleted`
    // (a workflow-authored constant); merge the signal output with a literal
    // to compose the tool's args in one selector.
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

    taskSelectGate: action({
      handler: TASK_SELECTION_GATE_HANDLER,
      input: { project: { from: "steps" }, fields: ["listTasks"] },
      effect: { requires: [TASK_SELECTION_GATE_HANDLER] },
      after: ["listTasks"],
    }),

    selectTask: awaitSignal({
      name: "task-selection",
      after: ["taskSelectGate"],
    }),

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

    clarifyGate: action({
      handler: CLARIFICATION_GATE_HANDLER,
      input: { project: { from: "steps" }, fields: ["analyze"] },
      effect: { requires: [CLARIFICATION_GATE_HANDLER] },
      after: ["analyze"],
    }),

    clarify: awaitSignal({ name: "clarification", after: ["clarifyGate"] }),

    // The executor sees the plan (analyze) + task (fetchTask) + any
    // clarification; their envelope keys (reply / content / answers) don't
    // collide, so the merge is lossless.
    execute: step({
      agent: executeAgent,
      input: {
        merge: [
          { from: "steps.analyze.output" },
          { from: "steps.fetchTask.output" },
          { from: "steps.clarify.output" },
        ],
      },
      after: ["clarify"],
    }),

    // The reviewer reads only `execute.output` — each produced item echoes
    // its brief, so it judges against the exact instruction with no join.
    reviewArtifacts: step({
      agent: reviewAgent,
      input: { from: "steps.execute.output" },
      after: ["execute"],
    }),

    reviewGate: action({
      handler: REVIEW_GATE_HANDLER,
      input: {
        project: { from: "steps" },
        fields: ["execute", "reviewArtifacts"],
      },
      effect: { requires: [REVIEW_GATE_HANDLER] },
      after: ["reviewArtifacts"],
    }),

    review: awaitSignal({ name: "review", after: ["reviewGate"] }),

    persist: action({
      handler: PERSIST_PIECES_HANDLER,
      input: { from: "steps.review.output" },
      effect: { requires: [PERSIST_PIECES_HANDLER] },
      after: ["review"],
    }),

    suggest: step({
      agent: suggestAgent,
      input: {
        merge: [
          { from: "steps.fetchTask.output" },
          { from: "steps.analyze.output" },
        ],
      },
      after: ["persist"],
    }),

    syncApprovalGate: action({
      handler: SYNC_APPROVAL_GATE_HANDLER,
      input: {
        project: { from: "steps" },
        fields: ["fetchTask", "selectTask", "analyze"],
      },
      effect: { requires: [SYNC_APPROVAL_GATE_HANDLER] },
      after: ["suggest"],
    }),

    // Write-back is human-gated on an explicit `confirm` flag — NOT on a
    // swallowed validation error. Confirming means "attach the approved output
    // as a note AND mark the task complete"; the writes are FATAL so a real
    // Attio failure (403/500) fails the run loudly instead of the user believing
    // a note landed when it didn't. Declining routes to a no-op leaf. The ids
    // (taskId, parentObject, parentRecordId) are assembled by the gate-prep
    // tool from prior step state, not typed by the human.
    approveSync: awaitSignal({
      name: "sync-approval",
      after: ["syncApprovalGate"],
    }),

    syncGate: gate({
      when: { from: "steps.approveSync.output.confirm" },
      then: "writeNote",
      else: "skipWriteBack",
      after: ["approveSync"],
    }),

    // The gate emits parentObject/parentRecordId/content/idempotencyKey
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
