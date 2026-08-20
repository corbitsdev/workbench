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

// The two names below do NOT pin against a real manager-tools bundle.
// `@corbits/github-tools` now ships a write path (CL-6340 Code Review
// MVP, PR #62) — `GITHUB_POST_PULL_REQUEST_REVIEW_TOOL` in
// pull-request-tools.ts — but under a different name and a different
// shape: one aggregated review per PR posted by the workflow run
// itself, not N per-reviewer-attributed comments from three separate
// agent definitions, and no merge-class tool exists at all (posting is
// comment-only by design). The names below still document what the
// CL-6322 §8.2 case's scorers were written to expect; a scorer
// referencing one of these will never see a matching tool call until
// either the case is rewritten against the real shape or a per-reviewer
// attributed posting path is added — see packages/evals/README.md's
// scoreboard for the current call.
export const GITHUB_POST_REVIEW_COMMENT_TOOL = "github_post_review_comment";
export const GITHUB_MERGE_PULL_REQUEST_TOOL = "github_merge_pull_request";
