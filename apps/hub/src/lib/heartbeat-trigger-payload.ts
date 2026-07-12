// Enriches a heartbeat schedule's trigger payload with the member's
// CURRENT `enabledSources` at fire time, rather than whatever was captured in
// the schedule row when it was created/last edited. The scheduler stores one
// static `triggerPayload` per row (see services/scheduler.ts), so without
// this a source toggle would only take effect on the next schedule edit, not
// the next fire — the ticket asks for a live read. Pure over its inputs so
// the fire-time enrichment is unit-testable without a DB.
export function enrichHeartbeatTriggerPayload(
  triggerPayload: Record<string, unknown>,
  fireKind: string,
  heartbeatKind: string,
  enabledSources: string[],
): Record<string, unknown> {
  if (fireKind !== heartbeatKind) return triggerPayload;
  return { ...triggerPayload, enabledSources };
}
