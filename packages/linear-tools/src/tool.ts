// The `linear_list_recent_issues` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Linear is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { listRecentLinearIssues } from "./client";

export const LINEAR_LIST_RECENT_ISSUES_TOOL = "linear_list_recent_issues";

/** Env this bundle needs beyond `BaseEnv`: the caller's Linear credential. */
export interface LinearEnv extends BaseEnv {
  /** Absent or empty means "not connected" — never a thrown error. */
  readonly linearApiKey?: string;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Linear is not connected for this user.",
    isError: true,
  };
}

async function runLinearListRecentIssues(
  env: LinearEnv,
  call: ToolCall,
): Promise<ToolResult> {
  if (env.linearApiKey === undefined || env.linearApiKey === "") {
    return notConnectedResult(call.id);
  }
  const since = call.arguments["since"];
  try {
    const issues = await listRecentLinearIssues(
      { apiKey: env.linearApiKey },
      typeof since === "string" ? { since } : {},
    );
    return { callId: call.id, content: JSON.stringify({ issues }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/linear-tools` bundle factory: one tool, one env key.
 * Pin this package's `linear` bundle on any agent that needs the
 * caller's recently updated Linear issues.
 */
export const linearTools = defineTool<LinearEnv>({
  id: "@corbits/linear-tools/linear",
  requires: ["linearApiKey"],
  definitions: [{ name: LINEAR_LIST_RECENT_ISSUES_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: LINEAR_LIST_RECENT_ISSUES_TOOL,
        description:
          "Lists issues assigned to the caller (identifier, title, state, " +
          "url, updated-at), most-recently-updated first. Returns an " +
          'error result naming "not connected" when no Linear credential ' +
          "is configured — never fabricate issues when this happens.",
        inputSchema: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description:
                "ISO 8601 timestamp; only issues updated after this are returned",
            },
          },
        },
      },
    ],
    run: (call, _signal) => runLinearListRecentIssues(env, call),
  }),
});
