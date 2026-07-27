// Native `interchange.tools` entry for
// @workbench/workflow-multi-source-collateral.
//
// This factory calls @workbench/tools-granola's and @workbench/tools-linear's
// exported factory functions, plus @workbench/tools-artifact's hub-backed
// definitions, directly in-process (see tools.ts) — mirroring
// sumble-account-intel's pattern of declaring its own `requires` rather than
// pinning those packages' own factories separately. `granola`/`linear` are
// declared but resolved LAZILY inside their own tools.ts handlers: an
// unconfigured tenant degrades only the facet that needs that provider
// (fetch-sources for a selected note/issue, list-issues for the chooser),
// never the whole tool package.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  createMultiSourceCollateralTools,
  MULTI_SOURCE_COLLATERAL_TOOLS_REQUIRES,
} from "./tools";

export const multiSourceCollateralCore = defineTool({
  id: "@workbench/workflow-multi-source-collateral/core",
  requires: MULTI_SOURCE_COLLATERAL_TOOLS_REQUIRES,
  factory: (env) =>
    createToolRunner(
      createMultiSourceCollateralTools(
        env as unknown as Record<string, unknown>,
      ),
    ),
});
