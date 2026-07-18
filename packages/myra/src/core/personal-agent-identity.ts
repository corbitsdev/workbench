/**
 * Control-plane identity signal for the personal agent (Myra chat).
 *
 * The sidecar cannot see template/instance names on the warm launch path — only
 * the resolved system prompt — so runtime opt-ins (dynamic tool exposure, and
 * any future Myra-only limits) need a structural marker. Matching model-facing
 * role prose ("You are Myra, Chief of Staff…") is load-bearing and brittle: a
 * role rewrite silently disables those features. This HTML comment is stamped
 * onto every personal-agent prompt at composition time and stripped before
 * inference so the model never sees it (CL-3194).
 */

export const PERSONAL_AGENT_IDENTITY_MARKER =
  "<!-- workbench:personal-agent -->";

const MARKER_PATTERN_GLOBAL = /<!--\s*workbench:personal-agent\s*-->/g;

/** True when the prompt carries the personal-agent control-plane marker. */
export function hasPersonalAgentIdentityMarker(systemPrompt: string): boolean {
  MARKER_PATTERN_GLOBAL.lastIndex = 0;
  return MARKER_PATTERN_GLOBAL.test(systemPrompt);
}

/**
 * Alias kept for call sites that want a boolean "is this a personal-agent
 * launch?" without caring about marker plumbing.
 */
export function isPersonalAgentIdentityPrompt(systemPrompt: string): boolean {
  return hasPersonalAgentIdentityMarker(systemPrompt);
}

/**
 * Stamp the marker onto a personal-agent system prompt. Idempotent: a prompt
 * that already carries the marker is returned unchanged so composition paths
 * that re-wrap do not double-stamp.
 */
export function withPersonalAgentIdentityMarker(systemPrompt: string): string {
  if (hasPersonalAgentIdentityMarker(systemPrompt)) return systemPrompt;
  const trimmed = systemPrompt.replace(/\s+$/, "");
  return `${trimmed}\n\n${PERSONAL_AGENT_IDENTITY_MARKER}`;
}

/**
 * Strip every personal-agent identity marker so none leak into the model-facing
 * prompt. Collapses blank lines left behind, matching the other control-plane
 * strip helpers (seed / timezone / inference-params).
 */
export function stripPersonalAgentIdentityMarker(systemPrompt: string): string {
  return systemPrompt
    .replace(MARKER_PATTERN_GLOBAL, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
