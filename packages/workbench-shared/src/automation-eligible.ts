/** Workflow kinds offered under Automations / Owner schedules (product allowlist).
 * Structural attachability is separate — a kind must pass BOTH gates. */
export const AUTOMATION_ELIGIBLE_KINDS = [
  "heartbeat",
  "prospect-engine",
  "last30days-research",
] as const;

export type AutomationEligibleKind = (typeof AUTOMATION_ELIGIBLE_KINDS)[number];

export function isAutomationEligibleKind(kind: string): boolean {
  return (AUTOMATION_ELIGIBLE_KINDS as readonly string[]).includes(kind);
}
