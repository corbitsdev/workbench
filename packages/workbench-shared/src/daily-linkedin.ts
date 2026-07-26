import { type } from "arktype";
import { SelectedPersonListSchema } from "./selected-person";

/**
 * Resume-boundary contract for the daily-linkedin workflow's `intake` gate.
 *
 * The recipient list is picked at intake and stored on the schedule as
 * `SelectedPerson` pairs (CL-4429). The pair shape is deliberately NOT
 * redeclared here — `SelectedPersonSchema` in `./selected-person` is the one definition,
 * shared with the `select-multi` form control that produces these values. A
 * structurally identical local copy is exactly the CL-4581 defect: one copy
 * gets widened, the other does not, and the suite stays green while the feature
 * is dead.
 *
 * At least one recipient is REQUIRED. The selection is explicit at pick time,
 * so an empty list means nobody, not everybody. This gate is filled by a
 * schedule and never by a person at run time, so an empty or malformed list
 * would otherwise fire a run that drafts for no one and still reports success.
 */
export const DailyLinkedInIntakePayloadSchema = type({
  recipients: SelectedPersonListSchema.atLeastLength(1),
});
export type DailyLinkedInIntakePayload =
  typeof DailyLinkedInIntakePayloadSchema.infer;
