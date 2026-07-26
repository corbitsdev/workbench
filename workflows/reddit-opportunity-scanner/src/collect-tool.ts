import type { AgentTool, BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { defineCredentialedToolPackage } from "@workbench/tool-credentials/factory";
import { withToleranceEnvelope } from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { REDDIT_HUB_TOOLS } from "@workbench/tools-reddit";

// Workflow-owned batch collect tool: `collect` was a `map` whose inner step
// was a single-search `deterministicToolStep`
// (`reddit_opportunity_scanner_collect_search`). `MapPrimitive.step` is typed
// `StepPrimitive`, not the `Primitive` union
// (`interchange/packages/workflow/src/definition/primitives.ts`), so a native
// `action` cannot host a map's inner step. Folded onto the same pattern
// `persist-tool.ts` and `granola_spawn_call_runs` established: the tool loops
// over the approved searches in plain TypeScript, so `collect` becomes one
// native `action`.
//
// Per-search tolerance is preserved, but moves from "one wrapper call per
// map iteration" to "one wrapper call per loop iteration inside this tool":
// one dead subreddit search must still degrade to a skip, not poison the
// whole curate pool (the last30days brief-poison class). Each search's
// result is independently passed through `withToleranceEnvelope`, so a
// per-search failure lands INSIDE `content.results[i]` as a tolerance-
// envelope object — the outer `ToolResult.isError` stays `false`
// unconditionally, because `runDeterministicToolStep` throws on an outer
// error and a native `action` has no escape from that throw.
//
// This DOES change `steps.collect.output`'s shape: from a bare array (one
// entry per search, `runMap`'s per-iteration return value) to
// `{ results: [...] }` under the action's single `ToolResult.content` —
// documented at the call site in index.ts and in `curate`'s prompt
// (`prompts.ts`). It also collapses N per-search checkpoints (map's
// `runStep` commits a separately-resumable `StepStarted`/`StepCompleted`
// pair per search) into 1 checkpoint for the whole batch — a crash
// mid-collect now re-runs every search on resume instead of resuming after
// the searches already completed. Acceptable: `reddit_subreddit_search`
// calls are cheap and the panel already caps the approved search count.

export const REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION: ToolDefinition =
  {
    name: "reddit_opportunity_scanner_collect_searches",
    description:
      "Internal reddit-opportunity-scanner workflow helper. Searches every approved subreddit query, tolerating a failed search (one dead source must not poison the whole curate pool) instead of failing the run.",
    inputSchema: {
      type: "object",
      properties: {
        searches: {
          type: "array",
          description: "The approved searches to run, in order.",
          items: {
            type: "object",
            properties: {
              subreddit: {
                type: "string",
                description: "The subreddit name.",
              },
              query: {
                type: "string",
                description: "The search query string.",
              },
              sort: { type: "string", description: "Sort order." },
              timeframe: { type: "string", description: "Time filter." },
              limit: {
                type: "number",
                description: "Maximum number of results.",
              },
            },
            required: ["subreddit", "query"],
          },
        },
      },
      required: ["searches"],
    },
  };

const collectSearchInner = defineCredentialedToolPackage({
  id: "@workbench/workflow-reddit-opportunity-scanner/collect-search-inner",
  provider: "scrapecreators",
  entries: {
    reddit_subreddit_search: REDDIT_HUB_TOOLS.reddit_subreddit_search,
  },
});

async function runOneSearch(
  env: BaseEnv,
  item: unknown,
  callId: string,
  signal: AbortSignal,
): Promise<unknown> {
  // `collectSearchInner(env)` is constructed PER SEARCH, inside this
  // dispatch — not once for the whole batch — for the same reason the
  // gamma/msc tolerant wrappers defer it: `defineCredentialedToolPackage`'s
  // factory throws `ToolCredentialMissingError` the instant it is invoked
  // with no `scrapecreators` credential in env, and that throw must land
  // inside `withToleranceEnvelope`'s per-search catch, not bubble up through
  // the batch handler and fail every other search too.
  const wrapped = await withToleranceEnvelope(callId, async () => {
    if (typeof item !== "object" || item === null) {
      throw new Error("each search must be an object");
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.subreddit !== "string" || typeof rec.query !== "string") {
      throw new Error(
        'each search requires string "subreddit" and "query" fields',
      );
    }
    const inner = collectSearchInner(env);
    return inner.run(
      { id: callId, name: "reddit_subreddit_search", arguments: rec },
      signal,
    );
  });
  return wrapped.content;
}

function createCollectSearchesTool(env: BaseEnv): AgentTool {
  return {
    kind: "full",
    definition: REDDIT_OPPORTUNITY_SCANNER_COLLECT_SEARCHES_DEFINITION,
    handler: async (call, signal) => {
      const args =
        typeof call.arguments === "object" && call.arguments !== null
          ? (call.arguments as Record<string, unknown>)
          : {};
      const searches = args.searches;
      if (!Array.isArray(searches)) {
        throw new Error("searches must be an array");
      }
      const results: unknown[] = [];
      for (const item of searches) {
        results.push(await runOneSearch(env, item, call.id, signal));
      }
      return { callId: call.id, isError: false, content: { results } };
    },
  };
}

export function createRedditOpportunityScannerCollectTools(
  env: BaseEnv,
): AgentTool[] {
  return [createCollectSearchesTool(env)];
}

/** Env keys this wrapper needs injected — same key the wrapped credentialed
 * package itself declares (the `scrapecreators` tool-credential key).
 * Re-exported so `interchange-tools.ts`'s `defineTool({ requires })` stays a
 * single source of truth with this file. */
export const COLLECT_TOOL_REQUIRES = [...collectSearchInner.requires];
