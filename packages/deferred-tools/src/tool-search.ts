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
    "Search this agent's other tools by keyword. The request lists only some of the tools available; " +
    "this one answers with the name, description and input schema of every tool matching the query, " +
    "and those tools become callable on the next turn. An empty query lists them all. Search before " +
    "saying a thing cannot be done.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
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
