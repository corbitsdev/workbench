// Native `interchange.tools` entry for @workbench/workflow-pain-point-collateral.
// Wraps `artifact_create` so `persist` can loop over every approved piece
// in-process (a `map`'s inner step can't be a native `action`), renaming
// each piece's `format` field to the tool's `kind` argument along the way.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  PERSIST_TOOL_REQUIRES,
  createPainPointCollateralPersistTools,
} from "./persist-tool";

export const painPointCollateralPersist = defineTool({
  id: "@workbench/workflow-pain-point-collateral/persist",
  requires: PERSIST_TOOL_REQUIRES,
  factory: (env) =>
    createToolRunner(createPainPointCollateralPersistTools(env)),
});
