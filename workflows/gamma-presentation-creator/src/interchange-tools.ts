// Native `interchange.tools` entry for @workbench/tools-gamma-presentation-creator.
// Stateless (pure field renames), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createGammaPresentationCreatorTools } from "./tools";

export const gammaPresentationCreator = defineTool({
  id: "@workbench/tools-gamma-presentation-creator/core",
  factory: () => createToolRunner(createGammaPresentationCreatorTools()),
});
