import { createToolRunner, defineTool } from "@intx/agent";
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { GRANOLA_HUB_TOOLS } from "./index";
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
