// Tool-name constants a scorer checks for. Kept in lockstep with each
// manager-tools bundle's own export (see each package's src/tool.ts) —
// tool-names.test.ts pins these against the real bundles so a rename
// there fails this package's tests instead of a scorer silently never
// matching.
export const CREATE_AGENT_TOOL = "create_agent";
export const ROUTINE_CREATE_TOOL = "routine_create";
export const DISPATCH_TASK_TOOL = "dispatch_task";
export const MEMORY_ADD_TOOL = "memory_add";
export const MEMORY_SEARCH_TOOL = "memory_search";
export const MEMORY_LIST_TOOL = "memory_list";
export const LIST_CONNECTIONS_TOOL = "list_connections";
export const REQUEST_CONNECTION_TOOL = "request_connection";

/** The tools a "build" step uses to stand up real, lasting workbench
 * state — the ones an interview must precede. */
export const BUILD_TOOLS = [
  CREATE_AGENT_TOOL,
  ROUTINE_CREATE_TOOL,
  DISPATCH_TASK_TOOL,
] as const;
