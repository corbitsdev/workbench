// Native `interchange.tools` entry for @workbench/tools-multi-source-collateral
// (CL-4464). Wraps `linear_list_issues` so the source-listing step can
// tolerate an unconfigured or failing Linear provider in-process, instead of
// the retired sidecar-wide `nonFatal` tag (no equivalent on native `action`).
// Declares the same tool-credential env key the wrapped package itself
// declares, so the hub still resolves + injects the `linear` credential when
// one is configured.

import { createToolRunner, defineTool } from "@intx/agent";
import {
  createMultiSourceCollateralListIssuesTools,
  LIST_ISSUES_TOOL_REQUIRES,
} from "./list-issues-tool";

export const multiSourceCollateralListIssues = defineTool({
  id: "@workbench/tools-multi-source-collateral/list-issues",
  requires: LIST_ISSUES_TOOL_REQUIRES,
  factory: (env) =>
    createToolRunner(createMultiSourceCollateralListIssuesTools(env)),
});
