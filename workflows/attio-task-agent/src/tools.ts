import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { ARTIFACT_CREATE_DEFINITION } from "@workbench/tools-artifact";
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
} from "./parse";

// This workflow's own tools (CL-2731 lineage, native-primitive cutover). Two
// families:
//
// 1. GATE-PREP tools — one per `awaitSignal` gate whose dock/run-page
//    affordance depends on run data (a prior step's fetched members/tasks, the
//    planner's decision, the executor+reviewer's drafts, the write-back
//    locators). Each is a plain `action` step's handler that ALWAYS succeeds
//    (a rendering concern, never a run failure) and returns a `UIBlock`-shaped
//    object as its `content` — the `review`/`member-selection`/etc. STEP_UI
//    entries reference it via `gateFromOutput`/`gateSourceStep` (see
//    `./step-ui.ts`). No `@workbench/blocks` import: every block is a plain
//    object literal matching that package's `UIBlock` shape structurally (the
//    host validates it with `isUIBlock`), so this package carries no
//    dependency on `@workbench/blocks`' React/framer-motion peers.
//
//    The `review` gate's malformed-drafts case is the one FATAL path in this
//    file — a genuine contract violation (the executor/reviewer prompts
//    REQUIRE strict JSON), not a rendering degrade; every other gate-prep tool
//    always succeeds, rendering a safe degraded block (a plain message, or a
//    choice with only "skip") rather than failing the run over a UI concern.
//
// 2. `persist-pieces` — the batch persist tool `attio-task-agent-persist`
//    dispatches (folded from the former `map` over `artifact_create`, see
//    index.ts).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceArgsObject(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

// Every gate-prep tool's input is a `project: { from: "steps" }, fields: [...]`
// selector (see index.ts) — the runtime's `steps` root is
// `Record<stepId, { output: unknown }>`, so a projected field arrives as
// `{ output: <the step's own recorded output> }`, not the output itself.
// Unwrap it here rather than at every call site.
function projectedStepOutput(entry: unknown): unknown {
  return isRecord(entry) && "output" in entry ? entry.output : undefined;
}

// -------------------------------------------------------------------------
// member-selection gate prep
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION: ToolDefinition =
  {
    name: "attio_task_agent_member_selection_gate",
    description:
      "Internal workflow helper. Shapes the workspace-members list into the choice UIBlock the member-selection gate's STEP_UI entry renders via gateFromOutput. Always succeeds — a rendering concern, never a run failure.",
    inputSchema: {
      type: "object",
      properties: {
        listMembers: {
          type: "object",
          description:
            "The listMembers step's own recorded output (the whole ToolResult envelope).",
        },
      },
      required: ["listMembers"],
    },
  };

function createMemberSelectionGateTool(): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_MEMBER_SELECTION_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const members = parseMembers(projectedStepOutput(args.listMembers));
      if (members.status !== "ok" || members.value.length === 0) {
        const text =
          members.status === "ok"
            ? "No workspace members are available to assign."
            : "Couldn't load workspace members.";
        return { callId: call.id, content: { kind: "text", text } };
      }
      return {
        callId: call.id,
        content: {
          kind: "choice",
          prompt: "Whose tasks do you want to work?",
          options: members.value.map((member) => ({
            id: member.assignee,
            label: member.label,
            value: member.assignee,
            // The raw assignee (email / member id) rides as secondary text
            // when it is not already the headline (the human name leads).
            ...(member.label !== member.assignee
              ? { description: member.assignee }
              : {}),
            payload: { assignee: member.assignee },
          })),
        },
      };
    },
  };
}

// -------------------------------------------------------------------------
// task-selection gate prep
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_task_selection_gate",
  description:
    "Internal workflow helper. Shapes the member's open-tasks list into the choice UIBlock the task-selection gate's STEP_UI entry renders via gateFromOutput. Always succeeds.",
  inputSchema: {
    type: "object",
    properties: {
      listTasks: {
        type: "object",
        description:
          "The listTasks step's own recorded output (the whole ToolResult envelope).",
      },
    },
    required: ["listTasks"],
  },
};

function createTaskSelectionGateTool(): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_TASK_SELECTION_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const tasks = parseTasks(projectedStepOutput(args.listTasks));
      if (tasks.status !== "ok" || tasks.value.length === 0) {
        const text =
          tasks.status === "ok"
            ? "No open tasks are available for this member."
            : "Couldn't load the task list.";
        return { callId: call.id, content: { kind: "text", text } };
      }
      return {
        callId: call.id,
        content: {
          kind: "choice",
          prompt: "Pick a task to work.",
          options: tasks.value.map((task) => ({
            id: task.taskId,
            label: task.label,
            value: task.taskId,
            ...(task.deadline !== undefined
              ? { description: `Due ${task.deadline.slice(0, 10)}` }
              : {}),
            payload: { taskId: task.taskId },
          })),
        },
      };
    },
  };
}

// -------------------------------------------------------------------------
// clarification gate prep
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_clarification_gate",
  description:
    "Internal workflow helper. Shapes the planner's decision into the choice UIBlock (with a free-text promptBox folded into answers) the clarification gate's STEP_UI entry renders via gateFromOutput. Always succeeds — a malformed/absent decision degrades to a plain continue.",
  inputSchema: {
    type: "object",
    properties: {
      analyze: {
        type: "object",
        description:
          "The analyze step's own recorded agent output ({ reply }).",
      },
    },
    required: ["analyze"],
  },
};

function createClarificationGateTool(): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_CLARIFICATION_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const decision = parseDecision(projectedStepOutput(args.analyze));
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
        callId: call.id,
        content: {
          kind: "choice",
          prompt: promptParts.join("\n\n"),
          promptBox: {
            placeholder: needsInput
              ? "Add the missing detail…"
              : "Add anything the agent should know (optional)…",
            payloadKey: "answers",
          },
          options: [
            { id: "continue", label: "Continue", value: "", payload: {} },
          ],
        },
      };
    },
  };
}

// -------------------------------------------------------------------------
// review gate prep — the one FATAL gate-prep tool. A malformed executor/
// reviewer reply is a genuine contract violation (both prompts require
// strict JSON), not a rendering degrade to swallow behind a placeholder gate
// a human could approve into persisting garbage.
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_review_gate",
  description:
    "Internal workflow helper. Shapes the executor's drafts + the reviewer's verdicts into the reviewList UIBlock the review gate's STEP_UI entry renders via gateFromOutput. Fatal — a malformed executor reply is a genuine contract violation.",
  inputSchema: {
    type: "object",
    properties: {
      execute: {
        type: "object",
        description:
          "The execute step's own recorded agent output ({ reply }).",
      },
      reviewArtifacts: {
        type: "object",
        description:
          "The reviewArtifacts step's own recorded agent output ({ reply }).",
      },
    },
    required: ["execute", "reviewArtifacts"],
  },
};

function verdictLabel(verdict: "pass" | "revise" | "reject"): string {
  if (verdict === "pass") return "approved";
  if (verdict === "reject") return "rejected";
  return "needs changes";
}

function createReviewGateTool(): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_REVIEW_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const drafts = parseExecutorOutputs(projectedStepOutput(args.execute));
      if (drafts.status !== "ok") {
        return {
          callId: call.id,
          isError: true,
          content:
            "execute step's reply did not decode to a valid drafts array",
        };
      }
      const reviewDecoded = parseReview(
        projectedStepOutput(args.reviewArtifacts),
      );
      const review = reviewDecoded.status === "ok" ? reviewDecoded.value : null;
      const reviewed = mergeReview(drafts.value, review);
      const defaultApproved = defaultSelectedIndices(reviewed, review !== null);
      return {
        callId: call.id,
        content: {
          kind: "reviewList",
          title: "Review the drafts",
          ...(review?.overall !== undefined ? { prompt: review.overall } : {}),
          displayFields: [
            { key: "title", label: "Draft" },
            { key: "type", label: "Type", kind: "badge" },
            { key: "verdict", label: "Verdict", kind: "badge" },
          ],
          rows: reviewed.map((r, i) => ({
            id: String(i),
            fields: {
              title: r.draft.title,
              type: r.draft.type,
              verdict:
                r.verdict !== undefined ? verdictLabel(r.verdict) : "pending",
            },
            payload: {
              type: r.draft.type,
              title: r.draft.title,
              content: r.draft.content,
            },
            defaultDecision: defaultApproved.has(i) ? "approved" : "rejected",
          })),
        },
      };
    },
  };
}

// -------------------------------------------------------------------------
// sync-approval gate prep — the DESTRUCTIVE gate. Confirming attaches a note
// to the linked Attio record and marks the task complete; skipping is always
// available (never gated on a note). A single `choice` block carries both
// options (STEP_UI's `gateFromOutput` resolves exactly one block per gate —
// unlike the former hand-written `blocks.ts`, which could return an array of
// two separate blocks). The dock's client-side "note required to confirm"
// disable is dropped as a consequence (both options share one promptBox with
// no `required`); the safety invariant survives at the /resume boundary
// instead — SyncApprovalPayloadSchema still REQUIRES a non-empty `content`
// on the confirm branch, so an empty-note confirm is rejected there.
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_sync_approval_gate",
  description:
    "Internal workflow helper. Shapes the fetched task/record + the planner's proposed note into the choice UIBlock the sync-approval gate's STEP_UI entry renders via gateFromOutput. Always succeeds — an unresolvable record/task degrades to skip-only, never a dead end.",
  inputSchema: {
    type: "object",
    properties: {
      fetchTask: {
        type: "object",
        description:
          "The fetchTask step's own recorded output (the whole ToolResult envelope).",
      },
      selectTask: {
        type: "object",
        description: "The selectTask awaitSignal step's own recorded output.",
      },
      analyze: {
        type: "object",
        description:
          "The analyze step's own recorded agent output ({ reply }).",
      },
    },
    required: ["fetchTask", "selectTask", "analyze"],
  },
};

const SKIP_WRITE_BACK_OPTION = {
  id: "skip",
  label: "Skip the write-back",
  value: "skip",
  payload: { confirm: false },
};

function createSyncApprovalGateTool(): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_SYNC_APPROVAL_GATE_DEFINITION,
    handler: async (call) => {
      const args = coerceArgsObject(call.arguments);
      const recordDecoded = parseFirstLinkedRecord(
        projectedStepOutput(args.fetchTask),
      );
      const taskDecoded = parseSelectedTaskId(
        projectedStepOutput(args.selectTask),
      );
      if (
        recordDecoded.status === "malformed" ||
        taskDecoded.status === "malformed"
      ) {
        return {
          callId: call.id,
          content: {
            kind: "choice",
            prompt:
              "Couldn't read the task details to sync — you can still skip the write-back.",
            options: [SKIP_WRITE_BACK_OPTION],
          },
        };
      }
      const record = recordDecoded.status === "ok" ? recordDecoded.value : null;
      const taskId = taskDecoded.status === "ok" ? taskDecoded.value : null;
      if (record === null || taskId === null) {
        return {
          callId: call.id,
          content: {
            kind: "choice",
            prompt:
              "No linked Attio record to write back to — nothing to sync.",
            options: [SKIP_WRITE_BACK_OPTION],
          },
        };
      }
      const decisionDecoded = parseDecision(projectedStepOutput(args.analyze));
      const proposedNote =
        decisionDecoded.status === "ok"
          ? decisionDecoded.value.proposedTaskUpdate?.note
          : undefined;
      return {
        callId: call.id,
        content: {
          kind: "choice",
          prompt: `Attach a note to the ${record.object} record ${record.recordId} and mark the task complete.`,
          promptBox: {
            placeholder:
              proposedNote !== undefined && proposedNote.length > 0
                ? `Suggested: ${proposedNote}`
                : "The note to attach to the record…",
            payloadKey: "content",
          },
          options: [
            {
              id: "attach-and-complete",
              label: "Attach and complete",
              value: "confirm",
              payload: {
                confirm: true,
                taskId,
                // Duplicated as idempotencyKey: attio_create_note keys retries
                // by it, attio_update_task by taskId.
                idempotencyKey: taskId,
                parentObject: record.object,
                parentRecordId: record.recordId,
              },
            },
            SKIP_WRITE_BACK_OPTION,
          ],
        },
      };
    },
  };
}

export function createAttioTaskAgentGateTools(): AgentTool[] {
  return [
    createMemberSelectionGateTool(),
    createTaskSelectionGateTool(),
    createClarificationGateTool(),
    createReviewGateTool(),
    createSyncApprovalGateTool(),
  ];
}

// -------------------------------------------------------------------------
// persist-pieces — folded from the former `map` over `artifact_create`
// (`MapPrimitive.step` is typed `StepPrimitive`, not `Primitive`, so an
// `action` cannot host a map's inner step at all — the pattern
// `granola_spawn_call_runs` established). Fatal by design (unchanged): any
// failed save fails the run.
// -------------------------------------------------------------------------

export const ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION: ToolDefinition = {
  name: "attio_task_agent_persist_pieces",
  description:
    "Internal workflow helper. Saves every approved piece as an artifact, failing the run if any save fails. The artifact kind is the planner's action type — intentionally free-form.",
  inputSchema: {
    type: "object",
    properties: {
      approvedPieces: {
        type: "array",
        description: "The approved pieces to save.",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            type: { type: "string" },
            content: { type: "string" },
          },
          required: ["title", "type", "content"],
        },
      },
    },
    required: ["approvedPieces"],
  },
};

const artifactCreateInner = defineHubBackedToolPackage({
  id: "@workbench/workflow-attio-task-agent/persist-pieces-inner",
  definitions: [ARTIFACT_CREATE_DEFINITION],
});

// The planner's system prompt (`prompts.ts`) caps `draftActions` at 4 — "AT
// MOST 4 draft actions, and prefer fewer" — and `approvedPieces` here is the
// human-reviewed subset of that same plan, so it can never legitimately
// exceed 4 either. Enforced here too, not just as a prompt instruction.
export const MAX_APPROVED_PIECES = 4;

function requireStringField(
  item: Record<string, unknown>,
  field: string,
): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: each item requires a non-empty "${field}"`,
    );
  }
  return value;
}

function createPersistPiecesTool(env: BaseEnv): AgentTool {
  return {
    kind: "full",
    definition: ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION,
    handler: async (call, signal) => {
      const args = coerceArgsObject(call.arguments);
      const items = args.approvedPieces;
      if (!Array.isArray(items)) {
        throw new Error("approvedPieces must be an array");
      }
      if (items.length > MAX_APPROVED_PIECES) {
        throw new Error(
          `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: approvedPieces has ${items.length} pieces, exceeding the documented cap of ${MAX_APPROVED_PIECES}`,
        );
      }
      // Constructed LAZILY here (inside the handler), not at factory-
      // construction time: a factory-level construction would resolve the
      // hub-rpc context for every tool in this package's bundle up front,
      // failing the whole bundle if that context were ever unavailable for
      // one call. Deferring to the actual call keeps that failure scoped to
      // this one persist attempt.
      const inner = artifactCreateInner(env);
      const results: unknown[] = [];
      for (const raw of items) {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("each approved piece must be an object");
        }
        const item = raw as Record<string, unknown>;
        const result = await inner.run(
          {
            id: call.id,
            name: "artifact_create",
            arguments: {
              title: requireStringField(item, "title"),
              kind: requireStringField(item, "type"),
              content: requireStringField(item, "content"),
            },
          },
          signal,
        );
        if (result.isError === true) {
          return {
            callId: call.id,
            isError: true,
            content:
              typeof result.content === "string"
                ? result.content
                : `${ATTIO_TASK_AGENT_PERSIST_PIECES_DEFINITION.name}: item persist failed: ${JSON.stringify(result.content)}`,
          };
        }
        results.push(result.content);
      }
      return { callId: call.id, content: { results } };
    },
  };
}

export function createAttioTaskAgentPersistTools(env: BaseEnv): AgentTool[] {
  return [createPersistPiecesTool(env)];
}

/** Env keys the persist wrapper needs injected — the same key the wrapped
 * package itself declares. Re-exported so `interchange-tools.ts`'s
 * `defineTool({ requires })` stays a single source of truth with this file. */
export const PERSIST_TOOL_REQUIRES = [...artifactCreateInner.requires];
