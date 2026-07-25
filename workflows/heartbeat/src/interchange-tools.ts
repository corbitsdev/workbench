// Native `interchange.tools` entry for @workbench/tools-heartbeat.
// Stateless (pure functions from @workbench/shared), so the factory touches
// no env keys and resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createHeartbeatTools } from "./tools";

export const heartbeat = defineTool({
  id: "@workbench/tools-heartbeat/core",
  factory: () => createToolRunner(createHeartbeatTools()),
});
