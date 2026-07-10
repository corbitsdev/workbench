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

// Loop guard for search_tools. The seam is advisory — the director cannot force
// the model — but a non-converging model (e.g. one repeatedly searching for a
// capability it can never load) must not spin on an identical payload forever.
// The escalation keys on CONSECUTIVE identical searches with no intervening
// load_tools: that is exactly the observed loop (search the same thing over and
// over, never advancing). Counting only consecutive-and-load-free runs means a
// long-lived session — Myra's persist across days — never accumulates toward a
// stop on ordinary, progressing use; only a genuine stuck run trips it. A run
// escalates its hint and then hard-errors. Distinct searches, a load_tools in
// between, and returned matches never count against or withhold anything.
const SAME_QUERY_WARN_THRESHOLD = 2;
const SAME_QUERY_TERMINAL_THRESHOLD = 4;

type SearchGuardState = {
  lastKey: string | null;
  consecutive: number;
};

function searchGuardKey(query: {
  query: string;
  package?: string;
  tags?: string[];
}): string {
  return JSON.stringify({
    query: query.query.trim().toLowerCase(),
    package: query.package ?? null,
    tags: (query.tags ?? []).map((t) => t.toLowerCase()).sort(),
  });
}

function searchHint(matchCount: number, repeatCount: number): string {
  if (repeatCount >= SAME_QUERY_WARN_THRESHOLD) {
    if (matchCount === 0) {
      return "You already ran this exact search and it has no matches. Do not repeat it — tell the user this capability is not available.";
    }
    return "You already ran this exact search. These are the only matches — call load_tools to enable one, or if none fit, tell the user this is not available instead of searching again.";
  }
  if (matchCount === 0) {
    return "No matching tools. The tools already in your function list are all that match.";
  }
  return "Call load_tools with the names or package you want, then call the tool.";
}

function runSearch(
  callId: string,
  catalog: ToolCatalog,
  guard: SearchGuardState,
  args: unknown,
): ToolResult {
  const parsed = SearchToolsArgs(args);
  if (parsed instanceof type.errors) {
    return errorResult(callId, `search_tools: ${parsed.summary}`);
  }

  const key = searchGuardKey(parsed);
  if (key === guard.lastKey) {
    guard.consecutive += 1;
  } else {
    guard.lastKey = key;
    guard.consecutive = 1;
  }
  const repeatCount = guard.consecutive;

  if (repeatCount >= SAME_QUERY_TERMINAL_THRESHOLD) {
    return errorResult(
      callId,
      `search_tools: you have run this identical search ${repeatCount} times in a row with the same result. Stop searching — enable a listed tool with load_tools, or tell the user this capability is unavailable / ask them for what is needed.`,
    );
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
      hint: searchHint(matches.length, repeatCount),
    },
  };
}

// A load_tools call means the model acted on a search result — real progress,
// not a loop — so it resets the consecutive-search run. This keeps a legitimate
// search → load → search → load progression (including one where load_tools
// fails transiently and the model retries) from ever reaching the hard stop and
// falsely reporting a capability as unavailable.
function resetSearchRun(guard: SearchGuardState): void {
  guard.lastKey = null;
  guard.consecutive = 0;
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
  const searchGuard: SearchGuardState = { lastKey: null, consecutive: 0 };
  return {
    definitions: [...CATALOG_TOOL_DEFINITIONS],
    async run(call: ToolCall): Promise<ToolResult> {
      if (call.name === SEARCH_TOOLS_NAME) {
        return runSearch(call.id, catalog, searchGuard, call.arguments);
      }
      if (call.name === LOAD_TOOLS_NAME) {
        resetSearchRun(searchGuard);
        return runLoad(call.id, catalog, exposure, call.arguments);
      }
      return errorResult(call.id, `Unknown catalog tool "${call.name}"`);
    },
  };
}
