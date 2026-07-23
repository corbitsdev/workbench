/**
 * Routine (schedule) eligibility, derived rather than hand-maintained
 * (CL-4204 was a fixed allowlist; a kind whose input contract changed could
 * silently drift off the list nobody remembered to update — or stay on it
 * after it stopped working unattended, as `granola-call` did: it reads a
 * required `noteId` straight off the trigger payload with no intake field
 * and no registered enricher, so every scheduled fire died on step one).
 *
 * A workflow is routine-eligible when every input its entry step reads
 * directly from the trigger payload is satisfiable unattended: either
 * declared as an intake field the schedule owner fills in when creating the
 * schedule, or supplied at fire time by a registered trigger-payload
 * enricher for that kind. Structural attachability (gate shape) is a
 * separate, still-required gate — see `isKindStructurallyAttachable` in
 * `apps/hub/src/lib/workflow-gate-info.ts`.
 *
 * This function is pure: the caller (apps/hub) reads the entry step's
 * required trigger fields from the committed embedded workflow defs and
 * checks kind membership in the hub's trigger-payload-enricher registry,
 * then passes the results in here.
 */
export function isRoutineEligibleKind(
  requiredTriggerFields: readonly string[],
  declaredIntakeFieldNames: ReadonlySet<string>,
  hasTriggerPayloadEnricher: boolean,
): boolean {
  return requiredTriggerFields.every(
    (field) => declaredIntakeFieldNames.has(field) || hasTriggerPayloadEnricher,
  );
}
