import { createToolRunner, defineTool } from "@intx/agent";
import {
  defineCredentialedToolPackage,
  defineHubBackedToolPackage,
} from "@workbench/tool-credentials/factory";
import { GRANOLA_HUB_TOOLS } from "./index";
import { GRANOLA_HUB_BACKED_DEFINITIONS } from "./hub-tools";
import { createGranolaWorkflowTools } from "./workflow-tools";

export const granola = defineCredentialedToolPackage({
  id: "@workbench/tools-granola/granola",
  provider: "granola",
  entries: GRANOLA_HUB_TOOLS,
});

/** Stateless pure tools for the granola-call workflow (no credentials). */
export const granolaWorkflow = defineTool({
  id: "@workbench/tools-granola/workflow",
  factory: () => createToolRunner(createGranolaWorkflowTools()),
});

/** Hub-executed granola workflow tools (fan-out); definitions ship here so
 * workflow steps can call them over the hub-backed rail. */
export const granolaHub = defineHubBackedToolPackage({
  id: "@workbench/tools-granola/hub",
  definitions: GRANOLA_HUB_BACKED_DEFINITIONS,
});
