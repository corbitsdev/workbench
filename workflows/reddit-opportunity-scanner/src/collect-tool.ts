import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition, ToolResult } from "@intx/types/runtime";
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { REDDIT_HUB_TOOLS } from "@workbench/tools-reddit";

// Workflow-owned tolerant wrapper (CL-4464): one dead subreddit search must
// degrade to a skip, not throw and poison the whole curate pool (the
// last30days brief-poison class). `collect` is a `map`'s inner step
// (`MapPrimitive.step` is typed `StepPrimitive`, not the `Primitive` union —
// interchange/packages/workflow/src/definition/primitives.ts — so a native
// `action` cannot host it at all; see index.ts). The tolerance still moves
// into a wrapper TOOL exactly as the other two CL-4464 cases: this wrapper
// calls the real `reddit_subreddit_search` in-process, over the same
// credentialed rail, and returns a completed non-error envelope on failure.
// `collect` therefore stays a `deterministicToolStep` (a plain `StepPrimitive`
// map inner step is unaffected by the action/map typing gap), but the
// `nonFatal` tag is no longer needed: the wrapper never lets the underlying
// throw reach the step-tool harness.

function toErrorMessage(result: ToolResult): string {
  const content = result.content;
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
  }
  return JSON.stringify(content);
}

export const REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION: ToolDefinition =
  {
    name: "reddit_opportunity_scanner_collect_search",
    description:
      "Internal reddit-opportunity-scanner workflow helper. Searches one approved subreddit query, tolerating a failed search (one dead source must not poison the whole curate pool) instead of failing the run.",
    inputSchema: {
      type: "object",
      properties: {
        subreddit: { type: "string", description: "The subreddit name." },
        query: { type: "string", description: "The search query string." },
        sort: { type: "string", description: "Sort order." },
        timeframe: { type: "string", description: "Time filter." },
        limit: { type: "number", description: "Maximum number of results." },
      },
      required: ["subreddit", "query"],
    },
  };

const collectSearchInner = defineCredentialedToolPackage({
  id: "@workbench/tools-reddit-opportunity-scanner/collect-search-inner",
  provider: "scrapecreators",
  entries: {
    reddit_subreddit_search: REDDIT_HUB_TOOLS.reddit_subreddit_search,
  },
});

function createCollectSearchTool(env: BaseEnv): AgentTool {
  // `collectSearchInner(env)` is constructed PER CALL, inside the handler —
  // not eagerly at factory-build time — for the same reason the gamma/msc
  // CL-4464 wrappers defer it: `defineCredentialedToolPackage`'s factory
  // throws `ToolCredentialMissingError` the instant it is invoked with no
  // `scrapecreators` credential in env, and that throw must land inside OUR
  // catch, not bubble up through `createCollectSearchTool` itself.
  return {
    kind: "full",
    definition: REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCH_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? call.arguments
          : {};
      try {
        const inner = collectSearchInner(env);
        const result = await inner.run(
          { id: call.id, name: "reddit_subreddit_search", arguments: args },
          signal,
        );
        if (result.isError === true) {
          return {
            callId: call.id,
            content: { isError: true, error: toErrorMessage(result) },
          };
        }
        return { callId: call.id, content: result.content };
      } catch (cause) {
        return {
          callId: call.id,
          content: {
            isError: true,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        };
      }
    },
  };
}

export function createRedditOpportunityScannerCollectTools(
  env: BaseEnv,
): AgentTool[] {
  return [createCollectSearchTool(env)];
}

/** Env keys this wrapper needs injected — same key the wrapped credentialed
 * package itself declares (the `scrapecreators` tool-credential key).
 * Re-exported so `interchange-tools.ts`'s `defineTool({ requires })` stays a
 * single source of truth with this file. */
export const COLLECT_TOOL_REQUIRES = [...collectSearchInner.requires];
