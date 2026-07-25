import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { withToleranceEnvelope } from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { LINEAR_HUB_TOOLS } from "@workbench/tools-linear";

// Workflow-owned tolerant wrapper: Linear may be unconfigured for a
// tenant — expected, not exceptional, here (this step just keeps Linear off
// the multi-source chooser when it is unset). Native `action` has no
// error-swallow equivalent to the sidecar-wide `nonFatal` tag, so the catch
// moves into this wrapper: it calls the real `linear_list_issues` in-process
// (the SAME public factory builder the real package uses,
// `defineCredentialedToolPackage`, over the SAME credentialed rail) and
// returns a completed, non-error envelope on failure instead of letting the
// throw propagate to the action dispatcher (`runDeterministicToolStep`
// throws on any `ToolResult.isError === true`, with no per-action nonFatal
// escape).

export const MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION: ToolDefinition = {
  name: "multi_source_collateral_list_issues",
  description:
    "Internal multi-source-collateral workflow helper. Lists Linear issues for the source picker, tolerating an unconfigured or failing Linear provider instead of failing the run.",
  inputSchema: {
    type: "object",
    properties: {
      first: {
        type: "number",
        description: "Maximum number of issues to return.",
      },
    },
  },
};

const listIssuesInner = defineCredentialedToolPackage({
  id: "@workbench/workflow-multi-source-collateral/list-issues-inner",
  provider: "linear",
  entries: { linear_list_issues: LINEAR_HUB_TOOLS.linear_list_issues },
});

function createListIssuesTool(env: BaseEnv): AgentTool {
  // `listIssuesInner(env)` is constructed PER CALL, inside the handler — not
  // eagerly at factory-build time. `defineCredentialedToolPackage`'s factory
  // throws `ToolCredentialMissingError` the instant it is invoked with no
  // `linear` credential in env, and that throw must land inside OUR catch
  // (Linear being unconfigured is exactly the case this wrapper tolerates),
  // not bubble up through `createListIssuesTool` itself — a throw there
  // would fail this wrapper's OWN factory construction, which the sidecar's
  // `buildStepTools` treats as "package skipped for a missing credential"
  // and would make the `action` dispatch a hard
  // `StepToolCredentialMissingError` instead of a completed envelope.
  return {
    kind: "full",
    definition: MULTI_SOURCE_COLLATERAL_LIST_ISSUES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      return withToleranceEnvelope(call.id, () => {
        const inner = listIssuesInner(env);
        return inner.run(
          { id: call.id, name: "linear_list_issues", arguments: args },
          signal,
        );
      });
    },
  };
}

export function createMultiSourceCollateralListIssuesTools(
  env: BaseEnv,
): AgentTool[] {
  return [createListIssuesTool(env)];
}

/** Env keys this wrapper needs injected — same key the wrapped credentialed
 * package itself declares (the `linear` tool-credential key). Re-exported so
 * `interchange-tools.ts`'s `defineTool({ requires })` stays a single source
 * of truth with this file. */
export const LIST_ISSUES_TOOL_REQUIRES = [...listIssuesInner.requires];
