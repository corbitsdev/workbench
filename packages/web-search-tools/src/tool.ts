// The `web_search` tool: an agent-facing wrapper around `./client.ts` that
// never throws. A missing credential or a failed call both come back as a
// completed `ToolResult` with `isError: true` — the calling agent's job
// (e.g. the last-30-days-research workflow) is to read that as "web search
// is not available right now" and say so honestly, never to have the run
// itself fail because one source is unreachable. Same contract as
// `@corbits/granola-tools`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { searchWeb } from "./client";

export const WEB_SEARCH_TOOL = "web_search";

/** Env this bundle needs beyond `BaseEnv`: the caller's Exa credential. */
export interface WebSearchEnv extends BaseEnv {
  /** Absent or empty means "not connected" — never a thrown error. */
  readonly webSearchApiKey?: string;
}

function notConnectedResult(callId: string): ToolResult {
  return {
    callId,
    content: "Web search is not connected for this user.",
    isError: true,
  };
}

async function runWebSearch(
  env: WebSearchEnv,
  call: ToolCall,
): Promise<ToolResult> {
  if (env.webSearchApiKey === undefined || env.webSearchApiKey === "") {
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
    const results = await searchWeb(
      { apiKey: env.webSearchApiKey },
      {
        query,
        ...(typeof numResults === "number" ? { numResults } : {}),
      },
    );
    return { callId: call.id, content: JSON.stringify({ results }) };
  } catch (err) {
    return {
      callId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}

/**
 * The `@corbits/web-search-tools` bundle factory: one tool, one env key
 * (`webSearchApiKey`). Pin this package on any agent that needs current
 * web results for a topic — backed by Exa, the same provider the OG
 * gtm-workbench's last30days-research workflow used for this source.
 */
export const webSearchTools = defineTool<WebSearchEnv>({
  id: "@corbits/web-search-tools/web-search",
  requires: ["webSearchApiKey"],
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
