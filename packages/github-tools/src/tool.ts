// The `github_activity` tool: an agent-facing wrapper around `./client.ts`
// that never throws. Unlike `@corbits/granola-tools` or
// `@corbits/web-search-tools`, GitHub's search API works keylessly — a
// missing `githubApiKey` just means a lower rate limit (60/hr vs 5000/hr),
// not "not connected" — so this tool always attempts the call. A failed
// call (rate-limited, network error) comes back as a completed
// `ToolResult` with `isError: true`; the calling agent's job is to read
// that as "GitHub is unavailable right now" and say so honestly, never to
// have the run itself fail because one source is unreachable.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { searchGitHubActivity } from "./client";

export const GITHUB_ACTIVITY_TOOL = "github_activity";

/** Env this bundle can use beyond `BaseEnv`: an optional GitHub token. */
export interface GitHubEnv extends BaseEnv {
  /** Absent means unauthenticated calls (lower rate limit), not "not connected". */
  readonly githubApiKey?: string;
}

async function runGitHubActivity(
  env: GitHubEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const query = call.arguments["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      callId: call.id,
      content: `${GITHUB_ACTIVITY_TOOL} requires a non-empty query argument`,
      isError: true,
    };
  }
  const days = call.arguments["days"];
  const limit = call.arguments["limit"];
  try {
    const items = await searchGitHubActivity(
      {
        ...(env.githubApiKey !== undefined ? { apiKey: env.githubApiKey } : {}),
      },
      {
        query,
        ...(typeof days === "number" ? { days } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      },
    );
    return { callId: call.id, content: JSON.stringify({ items }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/github-tools` bundle factory: one tool, one optional env
 * key (`githubApiKey`). Pin this package on any agent that needs recently
 * active GitHub repos, issues, and PRs for a topic — works with no
 * credential at all, at GitHub's unauthenticated rate limit.
 */
export const githubTools = defineTool<GitHubEnv>({
  id: "@corbits/github-tools/github-activity",
  requires: [],
  definitions: [{ name: GITHUB_ACTIVITY_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: GITHUB_ACTIVITY_TOOL,
        description:
          "Searches GitHub for recently active repositories, issues, and " +
          "pull requests matching a topic. Scope the search tightly: " +
          "pass specific keyword terms and a narrow days window. Do not " +
          "include GitHub search qualifiers like is:issue or repo: in " +
          "the query; those are added automatically.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Topic keywords to search for.",
            },
            days: {
              type: "number",
              description: "Number of days to look back (default 30).",
            },
            limit: {
              type: "number",
              description:
                "Maximum results per category — repos, issues, PRs each (1-25, default 5).",
            },
          },
          required: ["query"],
        },
      },
    ],
    run: (call, _signal) => runGitHubActivity(env, call),
  }),
});
