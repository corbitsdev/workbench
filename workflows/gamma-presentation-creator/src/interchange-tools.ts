// Native `interchange.tools` entry for @workbench/tools-gamma-presentation-creator.
// The `core` factory is stateless (pure field renames) and touches no env
// keys. The `fetch` factory wraps `artifact_read`/`granola_get_note`
// so this workflow can tolerate a missing/failed source in-process; it
// declares the same env keys those underlying packages require.

import { createToolRunner, defineTool } from "@intx/agent";
import { createGammaPresentationCreatorTools } from "./tools";
import {
  createGammaPresentationCreatorFetchTools,
  FETCH_TOOLS_REQUIRES,
} from "./fetch-tools";

export const gammaPresentationCreator = defineTool({
  id: "@workbench/tools-gamma-presentation-creator/core",
  factory: () => createToolRunner(createGammaPresentationCreatorTools()),
});

export const gammaPresentationCreatorFetch = defineTool({
  id: "@workbench/tools-gamma-presentation-creator/fetch",
  requires: FETCH_TOOLS_REQUIRES,
  factory: (env) =>
    createToolRunner(createGammaPresentationCreatorFetchTools(env)),
});
