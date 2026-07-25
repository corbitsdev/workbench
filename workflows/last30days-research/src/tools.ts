import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  type ToolCredential,
  getToolCredential,
} from "@workbench/tool-credentials";
import { toleranceFailureContent } from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { EXA_HUB_TOOLS } from "@workbench/tools-exa";
import { GITHUB_HUB_TOOLS } from "@workbench/tools-github";
import { REDDIT_HUB_TOOLS } from "@workbench/tools-reddit";
import { X_HUB_TOOLS } from "@workbench/tools-x";
import { YOUTUBE_HUB_TOOLS } from "@workbench/tools-youtube";
import { createHackerNewsTools } from "@workbench/tools-hackernews";
import { createPolymarketTools } from "@workbench/tools-polymarket";

// Workflow-owned "safe" source tools (CL-4464): each of the 13 last30days
// source-fetch steps was a best-effort `deterministicToolStep` carrying the
// `nonFatal` dispatch tag, because the native `action` primitive has no
// error-swallow — a thrown tool error inside an action's `ctx.perform` always
// fails the run (see `apps/sidecar/src/action-tool-handler.ts`). Moving the
// tolerance INSIDE a tool this workflow owns lets every source step become a
// plain native `action`: the wrapper calls the real source tool's exported
// handler in-process (no hub RPC, no duplicated fetch/parse logic — this is
// the same handler `@workbench/tools-exa`/`tools-github`/etc. hand the
// sidecar's own credentialed-tool-package factory) and, on a throw, returns a
// SUCCESSFUL string-tool result whose JSON body carries `{ isError: true,
// error }`. Critically the wrapper's own `ToolResult.isError` stays false —
// `runDeterministicToolStep` only throws when the dispatched tool's
// `ToolResult.isError` is true and `nonFatal` was not set (which the action
// path never sets), so a wrapper that reports success at the ToolResult
// level, while embedding the failure as data, is what keeps the step (and
// the run) alive. `packages/tools-last30days`'s `collect` tool parses this
// embedded envelope the same way it already parses a degraded step's plain
// `isError` envelope (see `parseSourceStep`).
//
// One wrapper tool exists per DISTINCT underlying source tool, not per
// workflow source key: `exa_search` backs four round-1/round-2 sources
// (web/webB/webC/web2), `reddit_search`/`x_search`/`youtube_search` each back
// two (round 1 + round 2), and the rest back one. Multiple `action` steps may
// share one `handler` ref — the sidecar's action-tool-handler registry
// resolves each ref once and reuses it — so this does not collapse the
// thirteen steps into fewer steps, only fewer underlying tool definitions.

function safeErrorEnvelope(err: unknown): string {
  return JSON.stringify(
    toleranceFailureContent(err instanceof Error ? err.message : String(err)),
  );
}

/**
 * Wrap a `kind: "string"` source tool so a thrown handler error becomes a
 * successful string result carrying a JSON error envelope, instead of
 * propagating. Every last30days source tool (`exa_search`, `hackernews_search`,
 * `github_activity`, `reddit_search`, `x_search`, `youtube_search`,
 * `polymarket_odds`) is a `kind: "string"` tool — asserted here rather than
 * assumed, since a `kind: "full"` tool's handler shapes its own `isError` and
 * would need a different wrap.
 */
export function wrapSafeStringTool(
  tool: AgentTool,
  name: string,
  description: string,
): AgentTool {
  if (tool.kind !== "string") {
    throw new Error(
      `last30days safe-source wrapper: "${tool.definition.name}" is not a kind:"string" tool; the nonFatal-replacement wrap only supports string tools`,
    );
  }
  const handler = tool.handler;
  return {
    kind: "string",
    definition: {
      ...tool.definition,
      name,
      description,
    },
    handler: async (
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<string> => {
      try {
        return await handler(args, signal);
      } catch (err) {
        return safeErrorEnvelope(err);
      }
    },
  };
}

export const SAFE_EXA_SEARCH_DEFINITION: ToolDefinition = {
  ...EXA_HUB_TOOLS.exa_search.definition,
  name: "last30days_safe_exa_search",
  description: `${EXA_HUB_TOOLS.exa_search.definition.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

export const SAFE_GITHUB_ACTIVITY_DEFINITION: ToolDefinition = {
  ...GITHUB_HUB_TOOLS.github_activity.definition,
  name: "last30days_safe_github_activity",
  description: `${GITHUB_HUB_TOOLS.github_activity.definition.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

export const SAFE_REDDIT_SEARCH_DEFINITION: ToolDefinition = {
  ...REDDIT_HUB_TOOLS.reddit_search.definition,
  name: "last30days_safe_reddit_search",
  description: `${REDDIT_HUB_TOOLS.reddit_search.definition.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

export const SAFE_X_SEARCH_DEFINITION: ToolDefinition = {
  ...X_HUB_TOOLS.x_search.definition,
  name: "last30days_safe_x_search",
  description: `${X_HUB_TOOLS.x_search.definition.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

export const SAFE_YOUTUBE_SEARCH_DEFINITION: ToolDefinition = {
  ...YOUTUBE_HUB_TOOLS.youtube_search.definition,
  name: "last30days_safe_youtube_search",
  description: `${YOUTUBE_HUB_TOOLS.youtube_search.definition.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

function firstTool(tools: AgentTool[], toolName: string): AgentTool {
  const found = tools.find((t) => t.definition.name === toolName);
  if (found === undefined) {
    throw new Error(
      `last30days safe-source wrapper: createTools() did not produce a "${toolName}" tool`,
    );
  }
  return found;
}

export function createSafeExaTools(config: {
  apiKey: string;
  baseURL: string;
}): AgentTool[] {
  const tool = firstTool(
    EXA_HUB_TOOLS.exa_search.createTools(config),
    "exa_search",
  );
  return [
    wrapSafeStringTool(
      tool,
      SAFE_EXA_SEARCH_DEFINITION.name,
      SAFE_EXA_SEARCH_DEFINITION.description ?? "",
    ),
  ];
}

export function createSafeGitHubTools(config: {
  apiKey: string;
  baseURL: string;
}): AgentTool[] {
  const tool = firstTool(
    GITHUB_HUB_TOOLS.github_activity.createTools(config),
    "github_activity",
  );
  return [
    wrapSafeStringTool(
      tool,
      SAFE_GITHUB_ACTIVITY_DEFINITION.name,
      SAFE_GITHUB_ACTIVITY_DEFINITION.description ?? "",
    ),
  ];
}

export function createSafeRedditTools(config: {
  apiKey: string;
  baseURL?: string;
}): AgentTool[] {
  const tools = REDDIT_HUB_TOOLS.reddit_search.createTools(config);
  const tool = firstTool(tools, "reddit_search");
  return [
    wrapSafeStringTool(
      tool,
      SAFE_REDDIT_SEARCH_DEFINITION.name,
      SAFE_REDDIT_SEARCH_DEFINITION.description ?? "",
    ),
  ];
}

export function createSafeXTools(config: {
  apiKey: string;
  baseURL: string;
}): AgentTool[] {
  const tool = firstTool(X_HUB_TOOLS.x_search.createTools(config), "x_search");
  return [
    wrapSafeStringTool(
      tool,
      SAFE_X_SEARCH_DEFINITION.name,
      SAFE_X_SEARCH_DEFINITION.description ?? "",
    ),
  ];
}

export function createSafeYouTubeTools(config: {
  apiKey: string;
  baseURL?: string;
}): AgentTool[] {
  const tool = firstTool(
    YOUTUBE_HUB_TOOLS.youtube_search.createTools(config),
    "youtube_search",
  );
  return [
    wrapSafeStringTool(
      tool,
      SAFE_YOUTUBE_SEARCH_DEFINITION.name,
      SAFE_YOUTUBE_SEARCH_DEFINITION.description ?? "",
    ),
  ];
}

const HACKERNEWS_SEARCH_DEFINITION = firstTool(
  createHackerNewsTools(),
  "hackernews_search",
).definition;

export const SAFE_HACKERNEWS_SEARCH_DEFINITION: ToolDefinition = {
  ...HACKERNEWS_SEARCH_DEFINITION,
  name: "last30days_safe_hackernews_search",
  description: `${HACKERNEWS_SEARCH_DEFINITION.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

const POLYMARKET_ODDS_DEFINITION = firstTool(
  createPolymarketTools(),
  "polymarket_odds",
).definition;

export const SAFE_POLYMARKET_ODDS_DEFINITION: ToolDefinition = {
  ...POLYMARKET_ODDS_DEFINITION,
  name: "last30days_safe_polymarket_odds",
  description: `${POLYMARKET_ODDS_DEFINITION.description} Internal last30days-research wrapper: a fetch failure degrades to a JSON { isError: true, error } body instead of failing the step.`,
};

/**
 * Build a safe-source tool whose credential is resolved LAZILY, inside the
 * handler, never at factory-construction time (CL-4454 correctness fix).
 * `getToolCredential` throws `ToolCredentialMissingError` the instant a
 * tenant has not configured the provider; if that throw happened while
 * building the tool package itself (as `defineCredentialedToolPackage` does
 * by calling it eagerly in its `factory`), the sidecar's `buildStepTools`
 * silently drops the whole package and the step then hard-fails with
 * `StepToolCredentialMissingError` — exactly the "worse than nonFatal"
 * regression this migration must not introduce. Resolving the credential
 * inside the handler instead means factory construction always succeeds,
 * and a missing credential degrades to the same `{ isError: true, error }`
 * envelope as any other source failure.
 */
export function createLazySafeCredentialedTool(opts: {
  provider: string;
  definition: ToolDefinition;
  buildSafeTools: (config: ToolCredential) => AgentTool[];
}): (env: Record<string, unknown>) => AgentTool {
  return (env) => ({
    kind: "string",
    definition: opts.definition,
    handler: async (
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<string> => {
      let config: ToolCredential;
      try {
        config = getToolCredential(env, opts.provider);
      } catch (err) {
        return safeErrorEnvelope(err);
      }
      const tool = firstTool(opts.buildSafeTools(config), opts.definition.name);
      if (tool.kind !== "string") {
        throw new Error(
          `last30days safe-source wrapper: "${opts.definition.name}" is not a kind:"string" tool`,
        );
      }
      return tool.handler(args, signal);
    },
  });
}

// Keyless sources need no credential resolution, so both wrappers are built
// eagerly (no per-call config) and returned together as one factory's tools.
export function createSafeKeylessTools(): AgentTool[] {
  return [
    wrapSafeStringTool(
      firstTool(createHackerNewsTools(), "hackernews_search"),
      SAFE_HACKERNEWS_SEARCH_DEFINITION.name,
      SAFE_HACKERNEWS_SEARCH_DEFINITION.description ?? "",
    ),
    wrapSafeStringTool(
      firstTool(createPolymarketTools(), "polymarket_odds"),
      SAFE_POLYMARKET_ODDS_DEFINITION.name,
      SAFE_POLYMARKET_ODDS_DEFINITION.description ?? "",
    ),
  ];
}
