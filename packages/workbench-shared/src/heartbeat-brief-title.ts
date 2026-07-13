const MORNING_BRIEF_KIND = "morning-brief";

/** Stable artifact `kind` for every persisted morning brief — never "report".
 * Kept as a named export so the workflow, the hub tool, and tests all pin the
 * same literal instead of re-typing the string (CL-3503: the brief's kind
 * must never drift to a generic value). */
export function morningBriefArtifactKind(): string {
  return MORNING_BRIEF_KIND;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Formats a UTC instant as DD/MM/YY. */
export function formatBriefDateDdMmYy(nowMs: number): string {
  const d = new Date(nowMs);
  const day = pad2(d.getUTCDate());
  const month = pad2(d.getUTCMonth() + 1);
  const year = pad2(d.getUTCFullYear() % 100);
  return `${day}/${month}/${year}`;
}

/**
 * Builds the morning brief's display name: `<User>'s Morning Brief - DD/MM/YY`.
 * Falls back to "Your Morning Brief - DD/MM/YY" when no display name is known
 * for the firing user (e.g. an agent-kind principal, or a lookup miss) so the
 * mail subject and persisted artifact title are never blank.
 */
export function formatHeartbeatBriefTitle(
  userDisplayName: string | undefined,
  nowMs: number,
): string {
  const datePart = formatBriefDateDdMmYy(nowMs);
  const name = userDisplayName?.trim();
  const possessive = name && name.length > 0 ? `${name}'s` : "Your";
  return `${possessive} Morning Brief - ${datePart}`;
}
