import {
  loadCommittedToolManifestFactories,
  writeBareToolNamesFromFactories,
} from "@workbench/tool-manifest";
import { HUB_ONLY_TOOL_SIDE_EFFECTS } from "./hub-only-tool-side-effects";
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
  "task_create",
  "task_update",
]);

/**
 * The LLM-safe names of the write tools that require human approval: every
 * `sideEffect: "write"` bare name minus {@link INTERNAL_WRITE_EXCLUSIONS},
 * mapped through the CL-2306 `canonicalizeToolNames` → `toLlmToolName`
 * transform the harness applies before it matches a tool call. The model never
 * calls the bare name, so the gated set must be keyed on the safe name. The
 * sidecar's approval-gated runner matches these names before invoking the tool.
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
 * Native (non-tool-package) writes that gate the same as an external write,
 * hand-listed because they carry no `sideEffect` classification in the hub's
 * `KNOWN_TOOLS` registry — they are local sidecar runners (mail, posix), not
 * credentialed/hub-backed tool entries, so `approvalGatedWriteNames` cannot
 * derive them from the tool registry. `mail_send` lands in a teammate's
 * mailbox — a member-visible, hard-to-undo action once Myra's chat persona
 * can call it — so it gates like any other external write rather than
 * running unattended.
 */
export const NATIVE_APPROVAL_GATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "mail_send",
]);

function hubOnlyWriteBareNames(): string[] {
  return Object.entries(HUB_ONLY_TOOL_SIDE_EFFECTS)
    .filter(([, effect]) => effect === "write")
    .map(([name]) => name);
}

/**
 * Build the LLM-safe names the sidecar's approval-gated runner matches — every
 * external / hard-to-undo write. Derived from committed manifest `sideEffects`
 * plus hub-only tools (tarballs carry no `sideEffect` metadata).
 */
export function buildApprovalGatedToolNames(): ReadonlySet<string> {
  const writeBare = [
    ...writeBareToolNamesFromFactories(loadCommittedToolManifestFactories()),
    ...hubOnlyWriteBareNames(),
  ];
  return new Set([
    ...approvalGatedWriteNames(writeBare),
    ...NATIVE_APPROVAL_GATED_TOOL_NAMES,
  ]);
}

/**
 * Materialized gated set for the sidecar harness. Recomputed from manifests at
 * module load; the hub drift test asserts this matches `KNOWN_TOOLS` sideEffects.
 */
export const APPROVAL_GATED_TOOL_NAMES: ReadonlySet<string> =
  buildApprovalGatedToolNames();
