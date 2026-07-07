import type { ToolDefinition } from "@intx/types/runtime";

// Flat convenience params throughout (CL-2319): kimi-class models skip
// optional nested-object params, so every argument the model must fill is a
// top-level primitive. `input`/`payload` stay objects because they ARE the
// opaque per-workflow payloads, not addressing parameters.

export const WORKFLOW_START_DEFINITION: ToolDefinition = {
  name: "workflow_start",
  description:
    "Start a workflow run by kind on behalf of the user. The run is recorded against this conversation, so it appears in the chat's workflow dock. Returns { runId, kind, status }. Use workflow_list_runs to check progress and workflow_signal to resolve a pending gate.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "The workflow kind to start, e.g. 'last30days-research'. Must be a deployed workflow kind.",
      },
      input: {
        type: "object",
        description:
          "Optional trigger payload for the workflow (workflow-specific fields). Omit for workflows that need no input.",
      },
    },
    required: ["kind"],
  },
};

export const WORKFLOW_LIST_RUNS_DEFINITION: ToolDefinition = {
  name: "workflow_list_runs",
  description:
    "List the user's workflow runs. By default only runs started from the current conversation are returned; pass allConversations=true to list the user's runs from every conversation. Returns runId, kind, status, createdAt, originConversationId, and for runs with status 'awaiting' a pendingGates array (signalName plus optional payloadSchema describing the gate's expected fields).",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description: "Optional workflow kind filter.",
      },
      allConversations: {
        type: "boolean",
        description:
          "Set true to include the user's runs from all conversations instead of only the current one.",
      },
    },
    required: [],
  },
};

export const WORKFLOW_SIGNAL_DEFINITION: ToolDefinition = {
  name: "workflow_signal",
  description:
    "Deliver a signal to a workflow run that is waiting on a gate (status 'awaiting'), resuming it. Read the run's pendingGates from workflow_list_runs first and pass that exact signalName — never invent one. Pass the runId, signalName, and an optional payload object matching the gate's fields. On a wrong signalName returns { ok: false, error, pendingGates } instead of succeeding. Returns the run's state after a successful signal.",
  inputSchema: {
    type: "object",
    properties: {
      runId: {
        type: "string",
        description:
          "The workflow run id (from workflow_start or workflow_list_runs).",
      },
      signalName: {
        type: "string",
        description: "The name of the signal the gate is waiting for.",
      },
      payload: {
        type: "object",
        description:
          "Optional gate payload (gate-specific fields, e.g. an approval decision).",
      },
    },
    required: ["runId", "signalName"],
  },
};

export const WORKFLOW_TOOL_DEFINITIONS: ToolDefinition[] = [
  WORKFLOW_START_DEFINITION,
  WORKFLOW_LIST_RUNS_DEFINITION,
  WORKFLOW_SIGNAL_DEFINITION,
];
