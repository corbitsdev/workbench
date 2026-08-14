// The `reddit_search` and `reddit_subreddit_search` tool bundle: an
// agent-facing wrapper around `./client.ts` that never throws. A missing
// credential or a failed call both come back as a completed `ToolResult`
// with `isError: true` — the calling agent's job (e.g. the
// reddit-opportunity-scanner workflow) is to read that as "Reddit is not
// available right now" and say so honestly, never to have the run itself
// fail because the source is unreachable.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { searchReddit, searchSubreddit } from "./client";
import type { RedditSearchParams } from "./client";

export const REDDIT_SEARCH_TOOL = "reddit_search";
export const REDDIT_SUBREDDIT_SEARCH_TOOL = "reddit_subreddit_search";

/** The handle this package declares in `interchange.credentials`. */
const SCRAPECREATORS_CREDENTIAL_HANDLE = "scrapecreators";

/**
 * Env this bundle needs beyond `BaseEnv`: the mediated-credential
 * capability, bound to a ScrapeCreators credential. There is no separate
 * Reddit credential — Reddit is reached through ScrapeCreators, the same
 * as any other ScrapeCreators-backed integration, since Reddit's own
 * public endpoints are IP-blocked from datacenter hosts and its
 * authenticated API needs a server-side OAuth flow this platform does
 * not run.
 */
export interface RedditEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Reddit is not connected for this user.",
    isError: true,
  };
}

/**
 * Resolve this bundle's mediated ScrapeCreators credential, or `null`
 * when it is not connected -- an absent `env.credentials`, an unbound
 * handle, or a denied grant all collapse to the same "not connected"
 * signal, never a thrown error out of the tool.
 */
async function resolveRedditCredential(
  env: RedditEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(
      SCRAPECREATORS_CREDENTIAL_HANDLE,
    );
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

function requiredStringArg(call: ToolCall, name: string): string | undefined {
  const value = call.arguments[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalStringArg(call: ToolCall, name: string): string | undefined {
  const value = call.arguments[name];
  return typeof value === "string" ? value : undefined;
}

function searchOptions(
  call: ToolCall,
): Pick<RedditSearchParams, "sort" | "timeframe"> {
  const options: { sort?: string; timeframe?: string } = {};
  const sort = optionalStringArg(call, "sort");
  const timeframe = optionalStringArg(call, "timeframe");
  if (sort !== undefined) options.sort = sort;
  if (timeframe !== undefined) options.timeframe = timeframe;
  return options;
}

async function runRedditSearch(
  env: RedditEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveRedditCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const query = requiredStringArg(call, "query");
  if (query === undefined) {
    return {
      callId: call.id,
      content: `${REDDIT_SEARCH_TOOL} requires a non-empty query argument`,
      isError: true,
    };
  }
  try {
    const posts = await searchReddit(
      { fetchImpl: credential.fetchImpl },
      { query, ...searchOptions(call) },
    );
    return { callId: call.id, content: JSON.stringify({ posts }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

async function runRedditSubredditSearch(
  env: RedditEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveRedditCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const subreddit = requiredStringArg(call, "subreddit");
  const query = requiredStringArg(call, "query");
  if (subreddit === undefined || query === undefined) {
    return {
      callId: call.id,
      content: `${REDDIT_SUBREDDIT_SEARCH_TOOL} requires non-empty subreddit and query arguments`,
      isError: true,
    };
  }
  try {
    const posts = await searchSubreddit(
      { fetchImpl: credential.fetchImpl },
      { subreddit, query, ...searchOptions(call) },
    );
    return { callId: call.id, content: JSON.stringify({ posts }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/reddit-tools` bundle factory: two tools sharing one
 * mediated credential (handle "scrapecreators"). Pin this package's
 * `reddit` bundle on any agent that needs to search Reddit, sitewide or
 * scoped to one subreddit.
 */
export const redditTools = defineTool<RedditEnv>({
  id: "@corbits/reddit-tools/reddit",
  requires: ["credentials"],
  definitions: [
    { name: REDDIT_SEARCH_TOOL },
    { name: REDDIT_SUBREDDIT_SEARCH_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: REDDIT_SEARCH_TOOL,
        description:
          "Searches Reddit across all subreddits for a query (title, url, " +
          "permalink, subreddit, created-at, upvotes, comment count). " +
          'Returns an error result naming "not connected" when no ' +
          "ScrapeCreators credential is configured — never fabricate " +
          "results when this happens.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text." },
            sort: {
              type: "string",
              description: 'e.g. "relevance", "new", "top".',
            },
            timeframe: {
              type: "string",
              description: 'e.g. "day", "week", "month", "year", "all".',
            },
          },
          required: ["query"],
        },
      },
      {
        name: REDDIT_SUBREDDIT_SEARCH_TOOL,
        description:
          "Searches one named subreddit for a query. Same result shape " +
          `and honest "not connected" degradation as ${REDDIT_SEARCH_TOOL}.`,
        inputSchema: {
          type: "object",
          properties: {
            subreddit: {
              type: "string",
              description: 'Subreddit name, without "r/", e.g. "startups".',
            },
            query: { type: "string", description: "Search query text." },
            sort: {
              type: "string",
              description: 'e.g. "relevance", "new", "top".',
            },
            timeframe: {
              type: "string",
              description: 'e.g. "day", "week", "month", "year", "all".',
            },
          },
          required: ["subreddit", "query"],
        },
      },
    ],
    run: (call, _signal) => {
      switch (call.name) {
        case REDDIT_SUBREDDIT_SEARCH_TOOL:
          return runRedditSubredditSearch(env, call);
        default:
          return runRedditSearch(env, call);
      }
    },
  }),
});
