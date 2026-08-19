// Consumer-facing labels for `@corbits/memory`'s degrade flags (CL-4600's
// windowed rate/hysteresis system) — `resource-vocabulary.ts`-shaped: the
// internal flag name never reaches the section's visible copy directly.
//
// `lexical_only` is deliberately excluded from `MEMORY_DEGRADE_FLAG_LABEL`.
// On a deploy that has chosen not to configure embeddings, that flag sits
// at a permanent ~100% windowed rate and `escalated.lexical_only` is
// permanently `true` — that is the correct, chosen steady state, not an
// incident, so the settings section must never alarm on it. Every other
// flag names a real fault (a provider outage, a timeout, an unreachable
// database) and belongs in the visible "search issues" line whenever it
// escalates.

export const MEMORY_DEGRADE_FLAG_LABEL: Record<string, string> = {
  dense_unavailable: "Meaning-based search stopped working",
  rerank_unavailable: "Result ranking stopped working",
  rerank_query_too_long: "Some long searches skip ranking",
  live_timeout: "Some searches are timing out",
  live_error: "Some searches are failing",
  memory_unavailable: "Memory was unreachable",
};

/** Every flag this section will ever alarm on, in the fixed order the
 * "search issues" line lists them — never lexical_only (see above). */
export const MEMORY_ALARM_DEGRADE_FLAGS: readonly string[] = Object.keys(
  MEMORY_DEGRADE_FLAG_LABEL,
);
