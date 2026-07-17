/**
 * Subagent-invocation business rules: the `member_agent_instance` template
 * key an invoked subagent instance is attributed under, and the structural
 * system-prompt marker the sidecar harness (`apps/sidecar/src/default-harness.ts`)
 * uses to select the invoke budget director — the same prompt-marker
 * convention `isTriageSessionPrompt` established, since `agentConfig` at that
 * seam carries no launch-time template/definition name, only the resolved
 * prompt.
 */

import {
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_NAME,
} from "../core/definition";

// Exported so callers attributing an invoked subagent instance and any
// downstream code that needs to recognize one (e.g. a future chat-side-panel
// listing) share one source of truth for the template key.
export const INVOKE_TEMPLATE_KEY = "myra-invoked-subagent";

/**
 * Fragment appended to a launched subagent's system prompt to mark it as an
 * unattended, delegated invocation. Present verbatim only in prompts built by
 * `withInvokeSessionMarker` — a reworded fragment would silently disable the
 * invoke budget director, same failure mode `isTriageSessionPrompt` guards
 * against.
 */
const INVOKE_SESSION_MARKER_FRAGMENT =
  "You were invoked by another agent to work on a delegated brief without a human watching this turn.";

/**
 * Appends the invoke marker to a target agent definition's own system prompt,
 * verbatim (no other personalization) — mirrors `launchAgentSession`'s
 * `persona` launch, which keeps the supplied prompt as-is.
 */
export function withInvokeSessionMarker(systemPrompt: string): string {
  return `${systemPrompt}\n\n${INVOKE_SESSION_MARKER_FRAGMENT}`;
}

/**
 * True when `systemPrompt` was built by `withInvokeSessionMarker`. Used at
 * the sidecar harness to select the budget-capped director for an invoked
 * subagent session without threading a new launch-time flag through
 * `agentConfig`.
 */
export function isInvokeSessionPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes(INVOKE_SESSION_MARKER_FRAGMENT);
}

/**
 * Personal-agent definitions are NOT invocable: nobody delegates to a second
 * Myra — the personal agent is per-member by construction, while invoke_agent
 * targets tenant-shared specialist definitions (invocable by any member of
 * the tenant; that asymmetry vs list_agents' owned-instance scope is
 * intentional — shared specialists are org-level). The definition display
 * name is the seed idempotency key for the personal templates, so it is the
 * structural marker here.
 */
export function isPersonalAgentDefinitionName(name: string): boolean {
  return name === PERSONAL_AGENT_NAME || name === PERSONAL_AGENT_TRIAGE_NAME;
}
