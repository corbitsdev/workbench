// How a deploy names this package. A code-sourced deploy carries a
// `name@range` pin plus the `interchange.workflow` entry path; both are
// properties of this package, so they are declared next to it rather
// than re-typed at each deploying call site.

/** The published package name a deploy's `name@range` pin selects. */
export const AGENT_RUNTIME_PACKAGE_NAME = "@corbits/agent-runtime";

/**
 * The `interchange.workflow` entry path the sidecar evaluates, matching
 * this package's own `package.json`.
 */
export const AGENT_RUNTIME_WORKFLOW_ENTRY = "./src/workflow.ts";
