// The `web_search` tool: an agent-facing wrapper around `./client.ts` that
// never throws. A missing credential or a failed call both come back as a
// completed `ToolResult` with `isError: true` — the calling agent's job
// (e.g. the last-30-days-research workflow) is to read that as "web search
// is not available right now" and say so honestly, never to have the run
// itself fail because one source is unreachable. Same contract as
// `@corbits/granola-tools`.
//
// The not-connected result also carries `missing-credential-detail`
// (`@workbench/connections`) so a chat surface can render the "Connect
// Exa" card instead of a dead-end error string — the same contract every
// other missing-credential surface in this repo reads. A genuine failure
// (bad response, network error) is different from "not connected": it's
// reported through `@corbits/error-sink` for the durable record before
// the plain-language `ToolResult` goes back to the caller, so a real bug
// here is never swallowed silently.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { CredentialCapability } from "@intx/types";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { missingCredentialDetail } from "@workbench/connections";
import { reportError } from "@corbits/error-sink";

import { searchWeb } from "./client";

export const WEB_SEARCH_TOOL = "web_search";

/** The handle this package declares in `interchange.credentials`. */
const EXA_CREDENTIAL_HANDLE = "exa";

/** Env this bundle needs beyond `BaseEnv`: the mediated-credential capability. */
export interface WebSearchEnv extends BaseEnv {
  readonly credentials?: CredentialCapability;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Web search is not connected for this user.",
    isError: true,
    detail: missingCredentialDetail(EXA_CREDENTIAL_HANDLE),
  };
}

/**
 * Resolve this bundle's mediated Exa credential, or `null` when it is
 * not connected -- an absent `env.credentials`, an unbound handle, or a
 * denied grant all collapse to the same "not connected" signal, never a
 * thrown error out of the tool.
 */
async function resolveWebSearchCredential(
  env: WebSearchEnv,
): Promise<{ fetchImpl: typeof fetch } | null> {
  if (env.credentials === undefined) return null;
  try {
    const mediated = await env.credentials.resolve(EXA_CREDENTIAL_HANDLE);
    return { fetchImpl: mediated.fetch as unknown as typeof fetch };
  } catch {
    return null;
  }
}

async function runWebSearch(
  env: WebSearchEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const credential = await resolveWebSearchCredential(env);
  if (credential === null) {
    return notConnectedResult(call.id);
  }
  const query = call.arguments["query"];
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      callId: call.id,
      content: `${WEB_SEARCH_TOOL} requires a non-empty query argument`,
      isError: true,
    };
  }
  const numResults = call.arguments["numResults"];
  try {
    const params =
      typeof numResults === "number" ? { query, numResults } : { query };
    const results = await searchWeb(
      { fetchImpl: credential.fetchImpl },
      params,
    );
    return { callId: call.id, content: JSON.stringify({ results }) };
  } catch (err) {
    const refId = reportError(err, { operation: WEB_SEARCH_TOOL });
    return {
      callId: call.id,
      content:
        (err instanceof Error ? err.message : String(err)) + ` (ref: ${refId})`,
      isError: true,
    };
  }
}

/**
 * The `@corbits/web-search-tools` bundle factory: one tool, one mediated
 * credential (handle "exa"). Pin this package on any agent that needs
 * current web results for a topic — backed by Exa, the same provider
 * the OG gtm-workbench's last30days-research workflow used for this
 * source.
 */
export const webSearchTools = defineTool<WebSearchEnv>({
  id: "@corbits/web-search-tools/web-search",
  requires: ["credentials"],
  definitions: [{ name: WEB_SEARCH_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: WEB_SEARCH_TOOL,
        description:
          "Searches the web for current information on a topic. " +
          'Returns an error result naming "not connected" when no ' +
          "web-search credential is configured — never fabricate " +
          "results when this happens.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query." },
            numResults: {
              type: "number",
              description: "Maximum results to return (1-25, default 5).",
            },
          },
          required: ["query"],
        },
      },
    ],
    run: (call, _signal) => runWebSearch(env, call),
  }),
});
