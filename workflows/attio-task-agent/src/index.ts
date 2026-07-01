import { awaitSignal, defineWorkflow, gate, map, step } from "@intx/workflow";
import { defineAgent } from "@intx/agent";
import {
  LLM_CREDENTIAL_NAME,
  LLM_DEFAULT_MODEL,
  LLM_PROVIDER,
  LLM_WRITER_MODEL,
  canonicalizeToolNames,
  deterministicToolStep,
  inlineInferenceStep,
} from "@workbench/agents";
import {
  buildAnalyzeSystemPrompt,
  buildGenerateSystemPrompt,
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
    "Grounds itself in the Attio task + record and internal context (read-only), then decides whether it can proceed.",
  systemPrompt: buildAnalyzeSystemPrompt(),
  tools: [],
  capabilities: canonicalizeToolNames([...GROUNDING_TOOLS]),
  inference: {
    sources: [{ provider: LLM_PROVIDER, model: LLM_DEFAULT_MODEL }],
  },
  tags: { credentialName: LLM_CREDENTIAL_NAME },
});

// -------------------------------------------------------------------------
// Workflow graph
//
//   listTasks    deterministicToolStep  attio_list_tasks {isCompleted:false}
//   selectTask   awaitSignal            task-selection      → {taskId}
//   fetchTask    deterministicToolStep  attio_get_task      from selectTask
//   analyze      step({agent})          ReAct, read-only    → AttioAnalyzeDecision
//   clarify      awaitSignal            clarification       → {answers?}   (⚠️ surfaces when status≠ready)
//   generate     inlineInferenceStep    merge fetch+analyze+clarify → {artifacts:[{kind,title,content}]}
//   review       awaitSignal            review              → {approvedPieces:[{kind,title,content}]}
//   persist      map artifact_create    over approvedPieces
//   suggest      inlineInferenceStep    merge fetch+analyze → completion summary + follow-ups
//   approveSync  awaitSignal            sync-approval       → {parentObject?,parentRecordId?,note?,markComplete?,taskId?}
//   writeNote    deterministicToolStep  attio_create_note   nonFatal (skips on empty approval)
//   writeComplete deterministicToolStep attio_update_task   nonFatal (skips on empty approval)
//
// The clarify loop is realized as a single always-present HITL checkpoint whose
// UI presentation is driven by analyze.output.status: a ⚠️ questions chat when
// the agent is blocked, a light confirm when it is ready. The ReAct agent does
// its own unbounded gathering WITHIN the analyze step, so most runs need no
// human clarification. (Multi-round human Q&A is a follow-up.)
//
// Write-back is human-gated by the approveSync signal and executed by nonFatal
// deterministic steps: an empty/declined approval payload makes each write no-op
// (a recorded skip) rather than mutating Attio.
// -------------------------------------------------------------------------

const persistStep = deterministicToolStep({
  id: "attio-task-agent-persist",
  tool: "artifact_create",
  input: { from: "trigger.payload" },
  argMap: {
    title: { from: "title" },
    kind: { from: "kind" },
    content: { from: "content" },
  },
});

// One inference per selected artifact kind (mapped). trigger.payload carries the
// kind for this iteration; the shared task/decision/clarification context is
// merged from the prior steps.
const generateOneStep = inlineInferenceStep({
  id: "attio-task-agent-generate-one",
  systemPrompt: buildGenerateSystemPrompt(),
  model: LLM_WRITER_MODEL,
  maxTokens: 16384,
  input: {
    merge: [
      { from: "steps.fetchTask.output" },
      { from: "steps.analyze.output" },
      { from: "steps.clarify.output" },
      { from: "trigger.payload" },
    ],
  },
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
      tool: "attio_list_workspace_members",
    }),

    selectMember: awaitSignal({
      name: "member-selection",
      after: ["listMembers"],
    }),

    // 1. List the selected member's open tasks.
    listTasks: deterministicToolStep({
      id: "attio-task-agent-list-tasks",
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

    // Generate ONE artifact per selected kind via map, each its own inference —
    // so a long blog/deck can't blow the token ceiling mid-array and lose the
    // whole batch (the last30days-poison failure). Quality-sensitive, so each
    // runs on the heavier writer model; analyze and suggest stay on the cheaper
    // default. Each map item is a kind string; shared task/decision context is
    // merged from the prior steps.
    generate: map({
      over: { from: "steps.analyze.output.selectedArtifactKinds" },
      step: generateOneStep,
      after: ["clarify"],
    }),

    review: awaitSignal({ name: "review", after: ["generate"] }),

    persist: map({
      over: { from: "steps.review.output.approvedPieces" },
      step: persistStep,
      after: ["review"],
    }),

    suggest: inlineInferenceStep({
      id: "attio-task-agent-suggest",
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
      tool: "attio_create_note",
      input: { from: "steps.approveSync.output" },
      argMap: {
        parentObject: { from: "parentObject" },
        parentRecordId: { from: "parentRecordId" },
        content: { from: "note" },
      },
      after: ["syncGate"],
    }),

    writeComplete: deterministicToolStep({
      id: "attio-task-agent-write-complete",
      tool: "attio_update_task",
      input: { from: "steps.approveSync.output" },
      argMap: {
        taskId: { from: "taskId" },
        isCompleted: { literal: true },
      },
      after: ["writeNote"],
    }),

    skipWriteBack: inlineInferenceStep({
      id: "attio-task-agent-skip-writeback",
      systemPrompt: "Reply with exactly: skipped. Output nothing else.",
      after: ["syncGate"],
    }),
  },
});
