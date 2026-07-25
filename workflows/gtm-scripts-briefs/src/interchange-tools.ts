// Native `interchange.tools` entry for @workbench/tools-gtm-scripts-briefs.
// Stateless (a pure reshape), so the factory touches no env keys and
// resolves no credential.

import { createToolRunner, defineTool } from "@intx/agent";
import { createGtmScriptsBriefsTools } from "./tools";

export const gtmScriptsBriefs = defineTool({
  id: "@workbench/tools-gtm-scripts-briefs/core",
  factory: () => createToolRunner(createGtmScriptsBriefsTools()),
});
