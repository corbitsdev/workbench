import { canonicalizeToolNames, toLlmToolName } from "./tool-names";

/**
 * Bare tool names classified `sideEffect: "write"` that must NOT open
 * ReviewGate. These are internal durable writes the agent owns end-to-end —
 * its own memory, artifacts, identity, skill drafts, sub-agent dispatch, and
 * workflow control — not external or hard-to-undo third-party actions.
 *
 * Every other write tool is approval-gated by default, so a newly added
 * external write auto-gates rather than silently shipping unattended. This is
 * the product set (a subset of `sideEffect: "write"`); the technical
 * read/write classification lives on each package's tool entry.
 */
export const INTERNAL_WRITE_EXCLUSIONS: ReadonlySet<string> = new Set([
  "memory_save",
  "write_artifact",
  "identity_set",
  "skill_draft",
  "dispatch_agent",
  "artifact_create",
  "artifact_write",
  "artifact_link_file",
  "artifact_link_presentation",
  "artifact_link_gamma_presentation",
  "workflow_start",
  "workflow_signal",
]);

/**
 * The LLM-safe names of the write tools that require human approval: every
 * `sideEffect: "write"` bare name minus {@link INTERNAL_WRITE_EXCLUSIONS},
 * mapped through the CL-2306 `canonicalizeToolNames` → `toLlmToolName`
 * transform the harness applies before it matches a tool call. The model never
 * calls the bare name, so the gated set must be keyed on the safe name — the
 * hub stamps these grants `effect: "ask"` and the sidecar resolves the ask.
 */
export function approvalGatedWriteNames(
  allWriteBareNames: readonly string[],
): Set<string> {
  const gated = allWriteBareNames.filter(
    (name) => !INTERNAL_WRITE_EXCLUSIONS.has(name),
  );
  return new Set(canonicalizeToolNames(gated).map(toLlmToolName));
}

/**
 * The materialized LLM-safe names the sidecar's approval-gated runner wrapper
 * matches a tool call against — every external / hard-to-undo write tool.
 *
 * This is a STATIC const (no launch-time hub fetch): the sidecar loads tool
 * tarballs that surface only `ToolDefinition` (no `sideEffect`), so it cannot
 * derive the set itself. Correctness is enforced by a hub drift test
 * (`approval-gated-tools.test.ts`) that recomputes the set from every tool's
 * `sideEffect: "write"` classification via {@link approvalGatedWriteNames} and
 * asserts it equals this const — so adding a write tool without gating it (or
 * mis-listing one here) fails CI. Keep in lockstep with that derivation.
 */
export const APPROVAL_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "attio__update_task",
  "attio__create_note",
  "gamma__create_from_template",
  "gamma__duplicate_presentation",
  "vercel__deploy_static_file",
  "deploy-artifact__vercel_deploy_artifact",
  "notion__create_page",
]);
