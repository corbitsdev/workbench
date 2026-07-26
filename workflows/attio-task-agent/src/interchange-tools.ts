// Native `interchange.tools` entries for @workbench/workflow-attio-task-agent.
//
// Two factories:
//   core    — the gate-prep tools (member/task/clarification/review/
//             sync-approval). None need a credential: they only reshape run
//             data already fetched by upstream Attio/agent steps into a
//             UIBlock.
//   persist — the batch `attio_task_agent_persist_pieces` tool, wrapping
//             `artifact_create` (hub-backed). Declares the hub-rpc env key so
//             the sidecar resolves it exactly as `@workbench/tools-artifact`'s
//             own factory would.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  createAttioTaskAgentGateTools,
  createAttioTaskAgentPersistTools,
  PERSIST_TOOL_REQUIRES,
} from "./tools";

export const attioTaskAgentCore = defineTool({
  id: "@workbench/workflow-attio-task-agent/core",
  factory: () => createToolRunner(createAttioTaskAgentGateTools()),
});

export const attioTaskAgentPersist = defineTool({
  id: "@workbench/workflow-attio-task-agent/persist",
  requires: PERSIST_TOOL_REQUIRES,
  factory: (env) => createToolRunner(createAttioTaskAgentPersistTools(env)),
});
