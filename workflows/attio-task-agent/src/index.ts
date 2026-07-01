import {
  awaitSignal,
  defineWorkflow,
  gate,
  map,
  sleep,
  step,
} from "@intx/workflow";
import type { Primitive } from "@intx/workflow";
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
import { attioTaskArtifactKinds } from "@workbench/shared";
import {
  buildAnalyzeSystemPrompt,
  buildKindSystemPrompt,
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
//   listMembers   deterministicToolStep  attio_list_workspace_members
//   selectMember  awaitSignal            member-selection    → {assignee}
//   listTasks     deterministicToolStep  attio_list_tasks    scoped to assignee
//   selectTask    awaitSignal            task-selection      → {taskId}
//   fetchTask     deterministicToolStep  attio_get_task      from selectTask
//   analyze       step({agent})          ReAct, read-only    → AttioAnalyzeDecision
//   clarify       awaitSignal            clarification       → {answers?}
//   selectKinds   awaitSignal            kind-selection      → {generate: {<kind>: bool …all kinds}}
//   gate-<kind>   gate on selectKinds.generate.<kind> → gen-<kind> | skip-<kind>  (per kind)
//   gen-<kind>    inlineInferenceStep    dedicated per-kind prompt (writer model)
//   skip-<kind>   sleep                  no-op leaf
//   review        awaitSignal            review              → {approvedPieces:[{kind,title,content}]}
//   persist       map artifact_create    over approvedPieces
//   suggest       inlineInferenceStep    merge fetch+analyze → completion summary + follow-ups
//   approveSync   awaitSignal            sync-approval       → {confirm,taskId,parentObject,parentRecordId,note}
//   syncGate      gate on confirm        → writeNote | skipWriteBack
//   writeNote     deterministicToolStep  attio_create_note   FATAL (loud on real Attio errors)
//   writeComplete deterministicToolStep  attio_update_task   FATAL, after writeNote
//
// Clarify is a single always-present HITL checkpoint; the panel shows the
// agent's questions when status is need_clarification, else a light confirm. The
// ReAct agent gathers autonomously within analyze, so most runs need no human
// clarification. (Multi-round human Q&A is a follow-up.)
//
// Write-back is human-gated on an explicit `confirm` flag (syncGate) and the
// writes are FATAL — a real Attio failure fails the run loudly rather than being
// swallowed. Note-first ordering: if writeComplete fails after writeNote, the
// task stays visibly open (not "done but empty"); a re-run could create a
// duplicate note (attio_create_note is not idempotent) — a documented caveat.
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

// Per-kind generation: each artifact kind routes to its OWN step with its OWN
// full, dedicated system prompt (no cross-kind context bleed) — quality geared
// per type. The `select-kinds` gate's payload is a COMPLETE boolean map over
// every kind (the panel always sends all keys, so no gate reads a missing key
// and throws); each kind's gate routes to its writer step or a no-op sleep leaf.
const KIND_CONTEXT = {
  merge: [
    { from: "steps.fetchTask.output" },
    { from: "steps.analyze.output" },
    { from: "steps.clarify.output" },
  ],
} as const;

function stepKeyForKind(kind: string): {
  gate: string;
  gen: string;
  skip: string;
} {
  return { gate: `gate-${kind}`, gen: `gen-${kind}`, skip: `skip-${kind}` };
}

// The leaves every generation branch terminates in; `review` waits on all of
// them (the pruned branch of each gate still completes, satisfying `after`).
export const GENERATION_LEAF_KEYS: string[] = attioTaskArtifactKinds.flatMap(
  (kind) => {
    const k = stepKeyForKind(kind);
    return [k.gen, k.skip];
  },
);

function generationSteps(): Record<string, Primitive> {
  const steps: Record<string, Primitive> = {};
  for (const kind of attioTaskArtifactKinds) {
    const k = stepKeyForKind(kind);
    steps[k.gate] = gate({
      when: { from: `steps.selectKinds.output.generate.${kind}` },
      then: k.gen,
      else: k.skip,
      after: ["selectKinds"],
    });
    steps[k.gen] = inlineInferenceStep({
      id: `attio-task-agent-gen-${kind}`,
      systemPrompt: buildKindSystemPrompt(kind),
      model: LLM_WRITER_MODEL,
      maxTokens: 16384,
      input: KIND_CONTEXT,
      after: [k.gate],
    });
    steps[k.skip] = sleep({ duration: 0, after: [k.gate] });
  }
  return steps;
}

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

    // Human picks which artifacts to generate. The panel pre-checks the agent's
    // suggested kinds (analyze.output.selectedArtifactKinds) and emits a COMPLETE
    // boolean map { generate: { "<kind>": bool, … all kinds } } so every per-kind
    // gate can read its key without the selector throwing on a missing one.
    selectKinds: awaitSignal({ name: "kind-selection", after: ["clarify"] }),

    // One dedicated-prompt writer step per kind (see generationSteps()).
    ...generationSteps(),

    review: awaitSignal({ name: "review", after: GENERATION_LEAF_KEYS }),

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

    // Declining the write-back is a no-op leaf — a sleep, not an LLM call
    // (a decline is not reasoning; matches the per-kind skip leaves).
    skipWriteBack: sleep({ duration: 0, after: ["syncGate"] }),
  },
});
