// The `linear_list_recent_issues` tool bundle: an agent-facing wrapper
// around `./client.ts` that never throws. A missing credential or a
// failed call both come back as a completed `ToolResult` with
// `isError: true` — the calling agent's job (e.g. the morning-brief
// workflow) is to read that as "Linear is not available right now"
// and say so honestly, never to have the run itself fail because one
// source is unreachable.
//
// CL-6028 declared this package's "linear" credential handle in
// `package.json` (`interchange.credentials`); CL-6032 wires the runtime
// half. `env.credentials` is the harness's consumer-gated capability
// (`@intx/harness/src/credential-capability.ts`,
// `createCredentialCapability`): the sidecar's step-invoker binding
// (`apps/sidecar/src/step-agent-tools.ts`) shapes one scoped to this
// package's consumer identity from the step's `CredentialWiring`
// (`ChildStepInvoker`'s 6th parameter, threaded through
// `apps/sidecar/src/workflow-substrate-factory/index.ts`'s `invokeStep`)
// and hands it to this bundle's factory. `credentials.resolve("linear")`
// throws when the handle has no bound credential (a workflow that never
// declared `credentialBindings` for this package) or the run's grants
// don't authorize this consumer to use it; both, like a network failure,
// degrade to the same honest "not connected" `ToolResult` rather than
// throwing out of the tool.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { listRecentLinearIssues } from "./client";

export const LINEAR_LIST_RECENT_ISSUES_TOOL = "linear_list_recent_issues";

/** The handle this package declares in `interchange.credentials`. */
const LINEAR_CREDENTIAL_HANDLE = "linear";

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential capability. */
export interface LinearEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Linear is not connected for this user.",
    isError: true,
  };
}

/**
 * Resolve this bundle's mediated Linear credential, or `null` when it is
 * not connected -- an absent `env.credentials`, an unbound handle, or a
 * denied grant all collapse to the same "not connected" signal, never a
 * thrown error out of the tool.
 */
async function resolveLinearCredential(
  env: LinearEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(LINEAR_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

async function runLinearListRecentIssues(
  env: LinearEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveLinearCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const since = call.arguments["since"];
  try {
    const issues = await listRecentLinearIssues(
      { fetchImpl: credential.fetchImpl },
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
 * The `@corbits/linear-tools` bundle factory: one tool, one mediated
 * credential. Pin this package's `li` bundle on any agent that needs
 * the caller's recently updated Linear issues. The bundle id's local
 * segment is kept short so `<id>:<tool name>` fits the 64-char OpenAI
 * function-name cap once wire-encoded (see `tool-name-limits.test.ts`).
 */
export const linearTools = defineTool<LinearEnv>({
  id: "@corbits/linear-tools/li",
  requires: ["credentials"],
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
