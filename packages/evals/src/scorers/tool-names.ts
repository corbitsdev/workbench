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

// The two names below do NOT pin against a real manager-tools bundle —
// `@corbits/github-tools` exposes only the read-only `github_activity`
// today (CL-6325). They document the tool names the CL-6322 §8.2 case
// expects a GitHub-write vertical to land under; a scorer referencing
// one of these will simply never see a matching tool call until CL-6325
// ships, which is the intended red signal.
export const GITHUB_POST_REVIEW_COMMENT_TOOL = "github_post_review_comment";
export const GITHUB_MERGE_PULL_REQUEST_TOOL = "github_merge_pull_request";
