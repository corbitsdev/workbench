// Native `interchange.tools` entry for @workbench/workflow-process-granola-call.
// Stateless (a pure field extract/rename), so the factory touches no env
// keys and resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createProcessGranolaCallTools } from "./tools";

export const processGranolaCall = defineTool({
  id: "@workbench/workflow-process-granola-call/core",
  factory: () => createToolRunner(createProcessGranolaCallTools()),
});
