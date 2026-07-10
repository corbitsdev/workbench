import { canonicalizeToolNames, toLlmToolName } from "./tool-names";

/**
 * Bare tool names that require forced human approval before they run.
 *
 * This is a **product** set: external or hard-to-undo mutations (CRM writes,
 * publishes, third-party generation). It is intentionally a *subset* of tools
 * classified `sideEffect: "write"` on package entries — internal durable
 * writes (memory, artifacts, identity, skill drafts) stay write-classified
 * but do not open ReviewGate on every agent turn.
 *
 * The sidecar gate matches LLM-safe names (`toLlmToolName` after
 * `canonicalizeToolNames`) — never these bare strings alone. See
 * {@link approvalGatedLlmToolNames}.
 */
export const APPROVAL_REQUIRED_BARE_NAMES = [
  // Attio CRM mutations
  "attio_update_task",
  "attio_create_note",
  // Vercel publishes
  "vercel_deploy_static_file",
  "vercel_deploy_artifact",
  // Gamma third-party generation / duplication
  "gamma_create_from_template",
  "gamma_duplicate_presentation",
] as const;

export type ApprovalRequiredBareName =
  (typeof APPROVAL_REQUIRED_BARE_NAMES)[number];

const APPROVAL_REQUIRED_BARE_SET: ReadonlySet<string> = new Set(
  APPROVAL_REQUIRED_BARE_NAMES,
);

export function isApprovalRequiredBare(name: string): boolean {
  return APPROVAL_REQUIRED_BARE_SET.has(name);
}

/**
 * LLM-facing names the approval gate must match. Package tools are presented
 * as `<pkg>__<short>` after CL-2306; bare names never reach the gate for
 * package tools.
 */
export function approvalGatedLlmToolNames(): ReadonlySet<string> {
  return new Set(
    canonicalizeToolNames([...APPROVAL_REQUIRED_BARE_NAMES]).map(toLlmToolName),
  );
}
