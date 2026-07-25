// Native `interchange.tools` entry for @workbench/tools-sumble-account-intel.
// Stateless (a pure field rename), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createSumbleAccountIntelTools } from "./tools";

export const sumbleAccountIntel = defineTool({
  id: "@workbench/tools-sumble-account-intel/core",
  factory: () => createToolRunner(createSumbleAccountIntelTools()),
});
