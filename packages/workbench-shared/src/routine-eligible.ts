/**
 * Routine (schedule) eligibility — an AUTHORING-TIME CHECK, not a runtime
 * gate (CL-4514: every deployed workflow is schedulable; there is no
 * structural or eligibility gate on schedule attachment). This function is
 * exercised only by `apps/hub/src/lib/routine-eligibility.integration.test.ts`
 * against the real committed embedded catalog, so a workflow whose entry step
 * requires a trigger-payload field nobody can supply unattended fails the
 * build instead of silently failing at fire time (the bug class that started
 * this line of work — `granola-call` reading a required `noteId` straight off
 * the trigger payload with no intake field and no registered enricher, so
 * every scheduled fire died on step one).
 *
 * A workflow passes this check when every input its entry step reads directly
 * from the trigger payload is satisfiable unattended: either declared as an
 * intake field the schedule owner fills in when creating the schedule, or
 * supplied at fire time by a registered trigger-payload enricher for that
 * kind.
 *
 * This function is pure: the caller (apps/hub's integration test) reads the
 * entry step's required trigger fields from the committed embedded workflow
 * defs and checks kind membership in the hub's trigger-payload-enricher
 * registry, then passes the results in here.
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
