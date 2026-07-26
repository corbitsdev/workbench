// Native `interchange.tools` entry for @workbench/workflow-attio-task-agent.
// Wraps `artifact_create` so `persist` can loop over every approved piece
// in-process (a `map`'s inner step can't be a native `action`).

import { createToolRunner, defineTool } from "@intx/agent";
import {
  PERSIST_TOOL_REQUIRES,
  createAttioTaskAgentPersistTools,
} from "./persist-tool";

export const attioTaskAgentPersist = defineTool({
  id: "@workbench/workflow-attio-task-agent/persist",
  requires: PERSIST_TOOL_REQUIRES,
  factory: (env) => createToolRunner(createAttioTaskAgentPersistTools(env)),
});
