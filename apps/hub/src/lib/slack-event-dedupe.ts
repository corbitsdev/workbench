// Slack's Events API delivers at-least-once; a retried delivery carries the
// SAME `event_id`. No shared dedupe utility exists in the repo (checked
// `packages/` and `apps/hub/src/lib` — the Linear webhook instead dedupes
// downstream on the mailbox `messageKey` unique constraint, which works there
// because every Linear event maps to a mailbox write. A Slack mention can
// resolve to ZERO mailbox writes — e.g. all mentioned users unmatched — so
// there is no downstream unique constraint to lean on, and this in-memory,
// insertion-ordered, size-bounded Set is the deliberate choice: bounded
// memory, no new table, correct for the common single-hub-process
// deployment. A multi-instance deployment would need a shared store (Redis /
// a DB table) — documented here as the seam to revisit if that ever lands.

const MAX_ENTRIES = 5_000;

export interface SlackEventDedupe {
  /** Returns true the FIRST time an id is seen (i.e. "process it"), false on
   * every subsequent call with the same id. */
  shouldProcess(eventId: string): boolean;
}

export function createSlackEventDedupe(): SlackEventDedupe {
  const seen = new Set<string>();
  return {
    shouldProcess(eventId: string): boolean {
      if (seen.has(eventId)) return false;
      if (seen.size >= MAX_ENTRIES) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.add(eventId);
      return true;
    },
  };
}
