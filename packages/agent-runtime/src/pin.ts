/**
 * The package name a rendered per-run workflow tree depends on and
 * imports its builder from. Declared next to the package rather than
 * re-typed in the renderer's template.
 */
export const AGENT_RUNTIME_PACKAGE_NAME = "@corbits/agent-runtime";

/**
 * The dependency range a rendered per-run tree pins
 * `@corbits/agent-runtime` at. The tree is materialized inside this
 * monorepo's own closure by the sidecar, so the workspace protocol is
 * the pin: every run deploys the one reviewed version in-tree, never a
 * separately published copy that could drift from the builder the hub
 * validated the config against.
 */
export const AGENT_RUNTIME_PACKAGE_RANGE = "workspace:*";
