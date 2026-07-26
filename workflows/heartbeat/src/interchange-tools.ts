// Native `interchange.tools` entry for @workbench/workflow-heartbeat/core.
//
// The format/document/notify tools are stateless (pure functions from
// @workbench/shared) and need no credential. `heartbeat_intake_source`
// is not stateless — it resolves a wired brief source's own
// tool credential in-process, so the factory declares every wired
// provider's env key as `requires` (see intake-tool.ts) and forwards `env`.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  createHeartbeatIntakeSourceTool,
  createHeartbeatTools,
  HEARTBEAT_INTAKE_SOURCE_ENV_KEYS,
} from "./tools";

export const heartbeat = defineTool({
  id: "@workbench/workflow-heartbeat/core",
  requires: [...HEARTBEAT_INTAKE_SOURCE_ENV_KEYS],
  factory: (env) =>
    createToolRunner([
      ...createHeartbeatTools(),
      createHeartbeatIntakeSourceTool(
        env as unknown as Record<string, unknown>,
      ),
    ]),
});
