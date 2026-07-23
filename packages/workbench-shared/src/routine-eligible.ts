/** Workflow kinds offered under Routines / Owner schedules (product allowlist).
 * Structural attachability is separate — a kind must pass BOTH gates. */
export const ROUTINE_ELIGIBLE_KINDS = [
  "heartbeat",
  "prospect-engine",
  "last30days-research",
] as const;

export type RoutineEligibleKind = (typeof ROUTINE_ELIGIBLE_KINDS)[number];

export function isRoutineEligibleKind(kind: string): boolean {
  return (ROUTINE_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}
