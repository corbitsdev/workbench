import { type } from "arktype";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import type { ToolCatalog, ToolExposureState } from "./schema";
import {
  resolveLoadRequest,
  searchCatalog,
  type SearchPackageMatch,
} from "./search";

export const SEARCH_TOOLS_NAME = "search_tools";
export const LOAD_TOOLS_NAME = "load_tools";

export const SEARCH_TOOLS_DEFINITION: ToolDefinition = {
  name: SEARCH_TOOLS_NAME,
  description:
    'Discover tools that are available but not currently shown in your function list. Most of your capabilities are loadable on demand — search here by what you want to do (e.g. "CRM records", "linear issue", "meeting notes", "deploy"), then call the match. When a search narrows to three or fewer tools they are loaded for you automatically and are immediately callable; a larger result comes with an explicit load_tools affordance listing the top matches. Optionally filter by `package` or `tags`. Returns matches grouped by package with a one-line description per tool.',
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
    'Enable tools discovered via search_tools so they appear in your function list and can be called. Prefer `names` — pass the exact tool names you need. `package` loads every tool in a package at once (e.g. "attio" loads all attio_* tools) and pins all their schemas to every later turn this session, so use it only when you genuinely need the whole package. Loaded tools stay available for the rest of this session. After loading, call the tool directly.',
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
      return "You already ran this exact search and it returned nothing. Do not repeat it verbatim — retry with different wording: synonyms, broader terms, a related concept, or browse by `package`/`tags`. Only conclude the capability is unavailable after several genuinely different phrasings also come up empty.";
    }
    return "You already ran this exact search. These are the only matches — call load_tools to enable one. If none fit, retry with different wording (synonyms, broader terms, or a `package`/`tags` filter) before concluding it is unavailable.";
  }
  if (matchCount === 0) {
    return "No matching tools. Retry with different wording — synonyms or broader terms — or browse by `package`/`tags`; the tools already in your function list may already cover this.";
  }
  return "Call load_tools with the names or package you want, then call the tool.";
}

// At or below this many total tool matches, search_tools loads them itself
// (name-scoped) in the same call — collapsing the search → load → call
// indirection the chat model tends to stall on. Above it, loading the whole set
// would be as expensive as a package-wholesale load, so the model is instead
// handed an explicit load_tools affordance and picks.
const AUTO_EXPOSE_TOOL_LIMIT = 3;
const AFFORDANCE_TOP_N = 6;

function flattenToolMatches(
  matches: SearchPackageMatch[],
): { name: string; description: string; score: number }[] {
  const all = matches.flatMap((m) =>
    m.tools.map((t) => ({
      name: t.name,
      description: t.description,
      score: t.score,
    })),
  );
  return all.sort((a, b) => b.score - a.score);
}

function affordanceLine(flat: { name: string }[]): string {
  const names = flat.slice(0, AFFORDANCE_TOP_N).map((t) => t.name);
  return `To enable, call load_tools with names: ${JSON.stringify(names)}`;
}

/** The catalog entry's package key for a tool name, or undefined if unmanaged. */
function packageForTool(
  catalog: ToolCatalog,
  name: string,
): string | undefined {
  for (const entry of catalog) {
    if (entry.tools.some((t) => t.name === name)) return entry.package;
  }
  return undefined;
}

/**
 * A tool's package is catalogued but the harness never constructed a live
 * runner for it — the usual cause is a missing tool credential (CL-3133's
 * package didn't load, so there is nothing to call). Rather than exposing a
 * name the agent runtime will reject, tell the model why and how to fix it.
 */
function credentialMissingNote(catalog: ToolCatalog, names: string[]): string {
  const packages = [
    ...new Set(names.map((n) => packageForTool(catalog, n) ?? n)),
  ];
  const list = packages.join(", ");
  return `${list} ${packages.length === 1 ? "needs a credential that is" : "need credentials that are"} not configured yet — ask your workspace Owner to add it in Capabilities (Settings), then call load_tools again.`;
}

function runSearch(
  callId: string,
  catalog: ToolCatalog,
  guard: SearchGuardState,
  exposure: ToolExposureState,
  isAvailable: (name: string) => boolean,
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
      `search_tools: you have run this identical search ${repeatCount} times in a row with the same result. Stop searching with the same words — either enable a listed tool with load_tools, or retry with genuinely different wording: synonyms, broader terms, or a package/tags filter. Only after several reworded searches also come up empty should you tell the user the capability is not available or ask them for what is needed.`,
    );
  }

  const matches = searchCatalog(catalog, {
    query: parsed.query,
    ...(parsed.package !== undefined ? { package: parsed.package } : {}),
    ...(parsed.tags !== undefined ? { tags: parsed.tags } : {}),
  });
  const packages = matches.map((m) => ({
    package: m.package,
    summary: m.summary,
    tags: m.tags,
    tools: m.tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  }));

  const flat = flattenToolMatches(matches);

  if (flat.length > 0 && flat.length <= AUTO_EXPOSE_TOOL_LIMIT) {
    const loaded = flat.filter((t) => isAvailable(t.name)).map((t) => t.name);
    const unavailable = flat
      .filter((t) => !isAvailable(t.name))
      .map((t) => t.name);
    for (const name of loaded) exposure.exposed.add(name);
    resetSearchRun(guard);

    let hint: string;
    if (unavailable.length === 0) {
      hint =
        loaded.length === 1
          ? `Loaded this tool: ${JSON.stringify(loaded)}. It is now in your function list — call it directly.`
          : `Loaded these tools: ${JSON.stringify(loaded)}. They are now in your function list — call them directly.`;
    } else if (loaded.length === 0) {
      hint = credentialMissingNote(catalog, unavailable);
    } else {
      hint = `Loaded these tools: ${JSON.stringify(loaded)}. They are now in your function list — call them directly. ${credentialMissingNote(catalog, unavailable)}`;
    }

    return {
      callId,
      content: {
        matchCount: matches.length,
        packages,
        loaded,
        ...(unavailable.length > 0 ? { needsCredential: unavailable } : {}),
        hint,
      },
    };
  }

  let hint = searchHint(matches.length, repeatCount);
  if (flat.length > AUTO_EXPOSE_TOOL_LIMIT) {
    hint = `${hint} ${affordanceLine(flat)}`;
  }
  return {
    callId,
    content: {
      matchCount: matches.length,
      packages,
      hint,
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
  isAvailable: (name: string) => boolean,
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
  const loaded = result.resolved.filter(isAvailable);
  const needsCredential = result.resolved.filter((n) => !isAvailable(n));
  for (const name of loaded) exposure.exposed.add(name);

  let warning: string | undefined;
  if (parsed.package !== undefined && result.unknownPackage === null) {
    const entry = catalog.find((e) => e.package === parsed.package);
    const count = entry?.tools.length ?? 0;
    warning = `Loaded the whole "${parsed.package}" package: ${count} tool schemas are now pinned to every later turn this session and cannot be unloaded. Next time load_tools with specific names to keep your tool list small.`;
  }

  let note: string;
  if (loaded.length > 0) {
    note = "These tools are now in your function list — call them directly.";
  } else if (needsCredential.length > 0) {
    note = credentialMissingNote(catalog, needsCredential);
  } else {
    note =
      "Nothing was loaded. Use search_tools to find the correct names or package.";
  }

  return {
    callId,
    content: {
      loaded,
      unknownNames: result.unknownNames,
      unknownPackage: result.unknownPackage,
      ...(needsCredential.length > 0 ? { needsCredential } : {}),
      ...(warning !== undefined ? { warning } : {}),
      note,
    },
  };
}

/**
 * Build the in-process catalog tool runner. Both tools mutate the shared
 * `exposure` set — `load_tools` always, `search_tools` when a small match set
 * auto-exposes — and the dynamic-tools director reads it on its next
 * inference call. The runner is
 * constructed by the harness with direct references to both objects, so the
 * effect crosses to the director in-process without any transport.
 */
export function createCatalogTools(opts: {
  catalog: ToolCatalog;
  exposure: ToolExposureState;
  /**
   * LLM-facing names the harness actually materialized a live runner for.
   * Omitted (e.g. in tests that don't care about the distinction) means every
   * catalogued tool is treated as callable. Names in the catalog but absent
   * here are catalogued-but-uncallable — typically a tool package whose
   * credential is not configured (CL-3795) — and `load_tools`/auto-expose
   * surface an actionable message instead of exposing a dead name.
   */
  availableToolNames?: ReadonlySet<string>;
  /**
   * Invoked after a call that added at least one NEW name to the exposure
   * set (load_tools, or a search_tools auto-expose). The harness uses it to
   * persist the set so loaded tools survive an evict-and-rebuild.
   */
  onExposureChanged?: (exposed: ReadonlySet<string>) => void;
}): CatalogRunner {
  const { catalog, exposure, availableToolNames, onExposureChanged } = opts;
  const searchGuard: SearchGuardState = { lastKey: null, consecutive: 0 };
  const isAvailable = (name: string): boolean =>
    availableToolNames === undefined || availableToolNames.has(name);
  return {
    definitions: [...CATALOG_TOOL_DEFINITIONS],
    async run(call: ToolCall): Promise<ToolResult> {
      const sizeBefore = exposure.exposed.size;
      const notifyIfGrew = (result: ToolResult): ToolResult => {
        if (
          onExposureChanged !== undefined &&
          exposure.exposed.size > sizeBefore
        ) {
          onExposureChanged(exposure.exposed);
        }
        return result;
      };
      if (call.name === SEARCH_TOOLS_NAME) {
        return notifyIfGrew(
          runSearch(
            call.id,
            catalog,
            searchGuard,
            exposure,
            isAvailable,
            call.arguments,
          ),
        );
      }
      if (call.name === LOAD_TOOLS_NAME) {
        resetSearchRun(searchGuard);
        return notifyIfGrew(
          runLoad(call.id, catalog, exposure, isAvailable, call.arguments),
        );
      }
      return errorResult(call.id, `Unknown catalog tool "${call.name}"`);
    },
  };
}
