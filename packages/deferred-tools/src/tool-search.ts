// `tool_search`: the one tool that is always visible, and the only way the
// model learns a deferred tool exists.

import { defineTool } from "@intx/agent";
import type { ToolBundle } from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import { reportError } from "@corbits/error-sink";
import { type } from "arktype";

import { readDeferredCatalog } from "./catalog";
import { renderCatalogLines, renderMatches, searchDefinitions } from "./match";

/** The name the director always keeps visible and watches for. */
export const TOOL_SEARCH_NAME = "tool_search";

const SearchInput = type({ query: "string" });

export const TOOL_SEARCH_DEFINITION: ToolDefinition = {
  name: TOOL_SEARCH_NAME,
  description:
    "Find the tools that are not listed above. This agent has more tools than the ones in this request; " +
    'call tool_search with a keyword describing what you need (for example "memory", "artifact", "save a note") ' +
    "and it answers with the name, description and input schema of every matching tool. Those tools become " +
    "callable on your next turn. Pass an empty query to list them all. Always search before telling the user " +
    "you cannot do something.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords describing the tool you need." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

function answer(callId: string, content: string, isError?: true): ToolResult {
  return { callId, content, ...(isError !== undefined ? { isError } : {}) };
}

function search(call: ToolCall): ToolResult {
  const parsed = SearchInput(call.arguments);
  if (parsed instanceof type.errors) {
    return answer(call.id, `tool_search takes { "query": string }: ${parsed.summary}`, true);
  }
  const catalog = readDeferredCatalog();
  const query = parsed.query.trim();
  if (query === "") return answer(call.id, renderCatalogLines(catalog));
  return answer(call.id, renderMatches(searchDefinitions(catalog, query), query));
}

export const toolSearch = defineTool({
  id: "@corbits/deferred-tools/tool-search",
  definitions: [{ name: TOOL_SEARCH_NAME }],
  factory: (): ToolBundle => ({
    definitions: [TOOL_SEARCH_DEFINITION],
    run: (call: ToolCall): Promise<ToolResult> => {
      try {
        return Promise.resolve(search(call));
      } catch (cause) {
        reportError(cause, { operation: "deferred_tools_tool_search" });
        return Promise.resolve(answer(call.id, "tool_search failed; try again.", true));
      }
    },
  }),
});
