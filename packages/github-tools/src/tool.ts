// The `github_activity` tool: an agent-facing wrapper around `./client.ts`
// that never throws. Unlike `@corbits/granola-tools`,
// `@corbits/web-search-tools`, or `@corbits/reddit-tools`, GitHub's
// search API works keylessly — an unresolved "github" credential just
// means a lower rate limit (60/hr vs 5000/hr with a token), not "not
// connected" — so this tool always attempts the call, mediated or not. A
// failed call (rate-limited, network error) comes back as a completed
// `ToolResult` with `isError: true`; the calling agent's job is to read
// that as "GitHub is unavailable right now" and say so honestly, never to
// have the run itself fail because one source is unreachable.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { searchGitHubActivity } from "./client";

export const GITHUB_ACTIVITY_TOOL = "github_activity";

/** The handle this package declares in `interchange.credentials`. */
const GITHUB_CREDENTIAL_HANDLE = "github";

/**
 * Env this bundle can use beyond `BaseEnv`: the mediated-credential
 * capability, optionally bound to a GitHub token. Unlike every other
 * package in this wave, an unresolved credential here is never "not
 * connected" — it degrades to an unauthenticated call at GitHub's lower
 * rate limit (60/hr vs 5000/hr with a token).
 */
export interface GitHubEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

/**
 * Resolve this bundle's mediated GitHub credential, or `null` when none
 * is available -- an absent `env.credentials`, an unbound handle, or a
 * denied grant all collapse to the same signal. Callers must treat
 * `null` as "run unauthenticated," never as an error: GitHub's search
 * API works keylessly, just at a lower rate limit.
 */
async function resolveGitHubCredential(
  env: GitHubEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(GITHUB_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
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
  const credential = await resolveGitHubCredential(env);
  const days = call.arguments["days"];
  const limit = call.arguments["limit"];
  try {
    const clientConfig =
      credential !== null ? { fetchImpl: credential.fetchImpl } : {};
    const withDays = typeof days === "number" ? { query, days } : { query };
    const params =
      typeof limit === "number" ? { ...withDays, limit } : withDays;
    const items = await searchGitHubActivity(clientConfig, params);
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
 * The `@corbits/github-tools` bundle factory: one tool, one optional
 * mediated credential (handle "github"). Pin this package on any agent
 * that needs recently active GitHub repos, issues, and PRs for a topic
 * — works with no credential bound at all, at GitHub's unauthenticated
 * rate limit.
 */
export const githubTools = defineTool<GitHubEnv>({
  id: "@corbits/github-tools/gh",
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
