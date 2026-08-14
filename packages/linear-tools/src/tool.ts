// The `linear_list_recent_issues` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Linear is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
//
// CL-6028: this package declares its "linear" credential handle in
// `package.json` (`interchange.credentials`) and a consuming workflow
// definition binds it via `credentialBindings`, so `buildCredentialDelivery`
// (`vendor/intx/db/src/credential-resolution.ts`) resolves a tenant-owned
// credential for the handle at launch — proven directly in
// `test/credential-delivery.drizzle.test.ts`. This module still reads
// `linearApiKey` off a plain env field rather than the harness's
// credentials capability (`vendor/intx/harness/src/credential-capability.ts`)
// because that capability is never wired into a running tool's env in this
// codebase: `BaseEnv` (`vendor/intx/agent/src/env.ts`) carries no
// `credentials` field, `createCredentialCapability` has zero callers anywhere
// under `vendor/intx`, and the one place a `CredentialWiring` reaches a step
// invoker (`ChildStepInvoker`'s 6th parameter, `vendor/intx/workflow-host/src/
// child/run-child.ts:287-293`) is a parameter the production sidecar binding
// (`apps/sidecar/src/workflow-substrate-factory/index.ts`'s `invokeStep`,
// typed with only 5 params) never accepts, so it is dropped before reaching
// `createWorkflowStepInvoker`/`attachStepTools`
// (`apps/sidecar/src/step-agent-tools.ts`) — neither of which mentions
// "credential" at all. Until that seam is built, `linearApiKey` stays the
// honest surface: nothing populates it today, so this tool correctly reports
// "not connected" rather than silently never receiving a bound credential.
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
