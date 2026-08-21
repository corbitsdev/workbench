// Two agent-facing pull-request tools: read a pull request's diff, and
// post one review on it. Both need the mediated "github" credential — a
// private diff is not readable keylessly and a review is a write — so an
// unresolved credential here is a real "not connected", unlike the
// keyless `github_activity` search in `./tool.ts`.
//
// Posting is not approval-gated. A review is a comment: it says what the
// reviewers found and never approves, requests changes, or merges, so it
// flows under the standing grant on the connection rather than stopping
// for a per-call decision.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  fetchPullRequestDiff,
  parsePullRequestUrl,
  postPullRequestReview,
} from "./pull-requests";

export const GITHUB_PULL_REQUEST_DIFF_TOOL = "github_pull_request_diff";
export const GITHUB_POST_PULL_REQUEST_REVIEW_TOOL = "github_post_pr_review";

const GITHUB_CREDENTIAL_HANDLE = "github";

/** Env this bundle needs: the mediated GitHub credential. */
export interface GitHubPullRequestEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

const DiffArguments = type({ pullRequestUrl: "string > 0" });

const ReviewArguments = type({
  pullRequestUrl: "string > 0",
  headSha: "string > 0",
  body: "string > 0",
  "comments?": type({
    path: "string > 0",
    line: "number > 0",
    body: "string > 0",
  }).array(),
});

function errorResult(
  callId: string,
  message: string,
  detail?: unknown,
): ToolResult {
  return {
    callId,
    content: message,
    isError: true,
    ...(detail !== undefined ? { detail } : {}),
  };
}

// The wire shape `@corbits/chat`'s orchestrator parses
// (`@workbench/connections`' `parseMissingCredentialDetail`) to render the
// live connect-service card. Written literally rather than imported: a
// sandboxed tool package stays free of a dependency on the hub-side
// connections package for one constant shape both sides already agree on
// by convention, the same way `toolDoneResult` narrows `event.type`
// without importing a shared literal.
function missingCredentialDetail(connectorId: string) {
  return { kind: "missing-credential", connectorId } as const;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The mediated credential's `fetch`, which injects the secret itself, or
 * `null` when the handle is unbound or the grant was denied.
 */
async function resolveConfig(
  env: GitHubPullRequestEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(GITHUB_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

const NOT_CONNECTED =
  "GitHub is not connected for this run, so the pull request cannot be " +
  "read or reviewed. Say so plainly instead of guessing at the change.";

async function runDiff(
  env: GitHubPullRequestEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const args = DiffArguments(call.arguments);
  if (args instanceof type.errors) {
    return errorResult(
      call.id,
      `${GITHUB_PULL_REQUEST_DIFF_TOOL}: ${args.summary}`,
    );
  }
  const config = await resolveConfig(env);
  if (config === null) {
    return errorResult(
      call.id,
      NOT_CONNECTED,
      missingCredentialDetail(GITHUB_CREDENTIAL_HANDLE),
    );
  }
  try {
    const ref = parsePullRequestUrl(args.pullRequestUrl);
    const diff = await fetchPullRequestDiff(config, ref);
    return { callId: call.id, content: JSON.stringify(diff) };
  } catch (err) {
    return errorResult(call.id, failureMessage(err));
  }
}

async function runPostReview(
  env: GitHubPullRequestEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const args = ReviewArguments(call.arguments);
  if (args instanceof type.errors) {
    return errorResult(
      call.id,
      `${GITHUB_POST_PULL_REQUEST_REVIEW_TOOL}: ${args.summary}`,
    );
  }
  const config = await resolveConfig(env);
  if (config === null) {
    return errorResult(
      call.id,
      NOT_CONNECTED,
      missingCredentialDetail(GITHUB_CREDENTIAL_HANDLE),
    );
  }
  try {
    const ref = parsePullRequestUrl(args.pullRequestUrl);
    const posted = await postPullRequestReview(config, ref, args.headSha, {
      body: args.body,
      comments: args.comments ?? [],
    });
    return { callId: call.id, content: JSON.stringify(posted) };
  } catch (err) {
    return errorResult(call.id, failureMessage(err));
  }
}

/**
 * The `@corbits/github-tools` pull-request bundle: read a diff, post one
 * review. Pin this package on any agent that reviews pull requests.
 */
export const githubPullRequestTools = defineTool<GitHubPullRequestEnv>({
  id: "@corbits/github-tools/prs",
  requires: ["credentials"],
  definitions: [
    { name: GITHUB_PULL_REQUEST_DIFF_TOOL },
    { name: GITHUB_POST_PULL_REQUEST_REVIEW_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: GITHUB_PULL_REQUEST_DIFF_TOOL,
        description:
          "Reads a GitHub pull request: its title, description, head " +
          "commit sha, and the patch for every changed file. Each file " +
          "also reports `changedLines`, the right-hand line numbers a " +
          "review comment can be anchored to.",
        inputSchema: {
          type: "object",
          properties: {
            pullRequestUrl: {
              type: "string",
              description:
                "The pull request's URL, e.g. " +
                "https://github.com/owner/repo/pull/123.",
            },
          },
          required: ["pullRequestUrl"],
        },
      },
      {
        name: GITHUB_POST_PULL_REQUEST_REVIEW_TOOL,
        description:
          "Posts one comment-only review on a pull request: a markdown " +
          "body plus optional inline comments. Anchor an inline comment " +
          "only to a line the diff reported in `changedLines` for that " +
          "file — GitHub rejects any other line. This never approves, " +
          "requests changes, or merges.",
        inputSchema: {
          type: "object",
          properties: {
            pullRequestUrl: {
              type: "string",
              description: "The pull request's URL.",
            },
            headSha: {
              type: "string",
              description:
                "The head commit sha the diff reported, which the review " +
                "is anchored to.",
            },
            body: {
              type: "string",
              description: "The review body, in markdown.",
            },
            comments: {
              type: "array",
              description: "Inline comments on lines the diff can anchor.",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  line: { type: "number" },
                  body: { type: "string" },
                },
                required: ["path", "line", "body"],
              },
            },
          },
          required: ["pullRequestUrl", "headSha", "body"],
        },
      },
    ],
    run: (call, _signal) =>
      call.name === GITHUB_PULL_REQUEST_DIFF_TOOL
        ? runDiff(env, call)
        : runPostReview(env, call),
  }),
});
