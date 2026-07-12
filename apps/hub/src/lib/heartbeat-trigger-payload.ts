const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const CREATED_AFTER_FALLBACK_MS = 24 * MS_PER_HOUR;
const CREATED_AFTER_MAX_LOOKBACK_MS = 7 * MS_PER_DAY;

// Derives the heartbeat brief's `createdAfter` cutoff at fire time. Prefers
// the schedule's own last-fire instant (day + hour, both UTC) so day 2+ never
// re-briefs a call already covered by yesterday's fire. Falls back to now
// minus 24h when the schedule has never fired. Clamps the lookback to 7 days
// so a schedule that was paused for a while does not dump a week of stale
// calls into a single brief.
export function computeHeartbeatCreatedAfter(
  nowMs: number,
  lastFiredDayUtc: number | null,
  hourUtc: number,
): string {
  const maxLookbackMs = nowMs - CREATED_AFTER_MAX_LOOKBACK_MS;
  if (lastFiredDayUtc === null) {
    return new Date(
      Math.max(nowMs - CREATED_AFTER_FALLBACK_MS, maxLookbackMs),
    ).toISOString();
  }
  const lastFiredMs = lastFiredDayUtc * MS_PER_DAY + hourUtc * MS_PER_HOUR;
  return new Date(Math.max(lastFiredMs, maxLookbackMs)).toISOString();
}

// Enriches a heartbeat schedule's trigger payload with the member's
// CURRENT `enabledSources` at fire time, rather than whatever was captured in
// the schedule row when it was created/last edited. The scheduler stores one
// static `triggerPayload` per row (see services/scheduler.ts), so without
// this a source toggle would only take effect on the next schedule edit, not
// the next fire — the ticket asks for a live read. Also stamps `createdAfter`
// so `granola_list_notes` time-bounds the brief instead of always returning
// the latest N notes regardless of age. Pure over its inputs so the fire-time
// enrichment is unit-testable without a DB.
export function enrichHeartbeatTriggerPayload(
  triggerPayload: Record<string, unknown>,
  fireKind: string,
  heartbeatKind: string,
  enabledSources: string[],
  nowMs: number,
  lastFiredDayUtc: number | null,
  hourUtc: number,
): Record<string, unknown> {
  if (fireKind !== heartbeatKind) return triggerPayload;
  return {
    ...triggerPayload,
    enabledSources,
    createdAfter: computeHeartbeatCreatedAfter(nowMs, lastFiredDayUtc, hourUtc),
  };
}
