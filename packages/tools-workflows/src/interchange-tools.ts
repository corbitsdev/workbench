// Native `interchange.tools` entry for @workbench/tools-workflows.
//
// Workflow-run control tools execute hub-side (they drive the hub's run
// records and the sidecar supervisor), so this is a hub-backed package: the
// factory carries only the tool definitions and forwards every call to the
// hub's scoped `/api/internal/hub-tools/run` endpoint via the injected
// hub-RPC context. Execution lives in
// apps/hub/src/tools/workflow-run-tools.ts (HUB_BACKED_TOOLS).

import { defineHubBackedToolPackage } from "@workbench/tool-credentials/factory";
import { WORKFLOW_TOOL_DEFINITIONS } from "./definitions";

export const workflows = defineHubBackedToolPackage({
  id: "@workbench/tools-workflows/workflows",
  definitions: WORKFLOW_TOOL_DEFINITIONS,
});
