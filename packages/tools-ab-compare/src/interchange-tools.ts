// Native `interchange.tools` entry for @workbench/tools-ab-compare.
// Stateless (pure assembly of workflow step outputs), so the factory touches
// no env keys and declares no credential requirement.

import { createToolRunner, defineTool } from "@intx/agent";
import { createAbCompareTools } from "./tools";

export const abCompare = defineTool({
  id: "@workbench/tools-ab-compare/compose",
  factory: () => createToolRunner(createAbCompareTools()),
});
