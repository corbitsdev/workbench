import { type } from "arktype";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { ToolCatalog, ToolExposureState } from "./schema";
import { resolveLoadRequest, searchCatalog } from "./search";

export const SEARCH_TOOLS_NAME = "search_tools";
export const LOAD_TOOLS_NAME = "load_tools";

export const SEARCH_TOOLS_DEFINITION: ToolDefinition = {
  name: SEARCH_TOOLS_NAME,
  description:
    'Discover tools that are available but not currently shown in your function list. Most of your capabilities are loadable on demand — search here by what you want to do (e.g. "CRM records", "linear issue", "meeting notes", "deploy"), then call load_tools to enable a match before using it. Optionally filter by `package` or `tags`. Returns matches grouped by package with a one-line description per tool. Read-only.',
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What you want to do, matched against tool names, descriptions, package names, and tags.",
      },
      package: {
        type: "string",
        description: "Optional package key to restrict the search to.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional tags; an entry matches if it carries any of them.",
      },
    },
    required: ["query"],
  },
};

export const LOAD_TOOLS_DEFINITION: ToolDefinition = {
  name: LOAD_TOOLS_NAME,
  description:
    'Enable tools discovered via search_tools so they appear in your function list and can be called. Pass `names` for specific tools and/or `package` to load a whole package at once (e.g. package "attio" loads every attio_* tool). Loaded tools stay available for the rest of this session. After loading, call the tool directly.',
  inputSchema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Exact tool names to enable, as returned by search_tools.",
      },
      package: {
        type: "string",
        description: "A package key to enable every tool it contains.",
      },
    },
    required: [],
  },
};

export const CATALOG_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  SEARCH_TOOLS_DEFINITION,
  LOAD_TOOLS_DEFINITION,
];

const SearchToolsArgs = type({
  query: "string",
  "package?": "string > 0",
  "tags?": "string[]",
});

const LoadToolsArgs = type({
  "names?": "string[]",
  "package?": "string > 0",
});

export type CatalogRunner = {
  definitions: ToolDefinition[];
  run(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
};

function errorResult(callId: string, message: string): ToolResult {
  return { callId, content: { error: message }, isError: true };
}

function runSearch(
  callId: string,
  catalog: ToolCatalog,
  args: unknown,
): ToolResult {
  const parsed = SearchToolsArgs(args);
  if (parsed instanceof type.errors) {
    return errorResult(callId, `search_tools: ${parsed.summary}`);
  }
  const matches = searchCatalog(catalog, {
    query: parsed.query,
    ...(parsed.package !== undefined ? { package: parsed.package } : {}),
    ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
  });
  return {
    callId,
    content: {
      matchCount: matches.length,
      packages: matches.map((m) => ({
        package: m.package,
        summary: m.summary,
        tags: m.tags,
        tools: m.tools.map((t) => ({
          name: t.name,
          description: t.description,
        })),
      })),
      hint:
        matches.length === 0
          ? "No matching tools. The tools already in your function list are all that match."
          : "Call load_tools with the names or package you want, then call the tool.",
    },
  };
}

function runLoad(
  callId: string,
  catalog: ToolCatalog,
  exposure: ToolExposureState,
  args: unknown,
): ToolResult {
  const parsed = LoadToolsArgs(args);
  if (parsed instanceof type.errors) {
    return errorResult(callId, `load_tools: ${parsed.summary}`);
  }
  if (parsed.names === undefined && parsed.package === undefined) {
    return errorResult(
      callId,
      "load_tools: provide `names`, `package`, or both.",
    );
  }
  const result = resolveLoadRequest(catalog, {
    ...(parsed.names !== undefined ? { names: parsed.names } : {}),
    ...(parsed.package !== undefined ? { package: parsed.package } : {}),
  });
  for (const name of result.resolved) exposure.exposed.add(name);
  return {
    callId,
    content: {
      loaded: result.resolved,
      unknownNames: result.unknownNames,
      unknownPackage: result.unknownPackage,
      note:
        result.resolved.length > 0
          ? "These tools are now in your function list — call them directly."
          : "Nothing was loaded. Use search_tools to find the correct names or package.",
    },
  };
}

/**
 * Build the in-process catalog tool runner. `search_tools` is read-only over
 * the catalog; `load_tools` mutates the shared `exposure` set, which the
 * dynamic-tools director reads on its next inference call. The runner is
 * constructed by the harness with direct references to both objects, so the
 * effect crosses to the director in-process without any transport.
 */
export function createCatalogTools(opts: {
  catalog: ToolCatalog;
  exposure: ToolExposureState;
}): CatalogRunner {
  const { catalog, exposure } = opts;
  return {
    definitions: [...CATALOG_TOOL_DEFINITIONS],
    async run(call: ToolCall): Promise<ToolResult> {
      if (call.name === SEARCH_TOOLS_NAME) {
        return runSearch(call.id, catalog, call.arguments);
      }
      if (call.name === LOAD_TOOLS_NAME) {
        return runLoad(call.id, catalog, exposure, call.arguments);
      }
      return errorResult(call.id, `Unknown catalog tool "${call.name}"`);
    },
  };
}
