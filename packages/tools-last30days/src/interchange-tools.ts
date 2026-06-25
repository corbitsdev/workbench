// Native `interchange.tools` entry for @workbench/tools-last30days.
// Stateless (pure functions from @workbench/last30days-core), so the
// factory touches no env keys.

import { createToolRunner, defineTool } from "@intx/agent";
import { createLast30daysTools } from "./tools";

export const last30days = defineTool({
  id: "@workbench/tools-last30days/core",
  factory: () => createToolRunner(createLast30daysTools()),
});
