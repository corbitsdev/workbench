import { type } from "arktype";

// A person picked at intake and carried in the trigger payload. `refId` is the
// bare user id the consuming workflow turns into a `usr_<refId>` mailbox
// address; `displayName` is cosmetic. The selection is a snapshot — a departed
// member leaves a dead `refId` until the schedule is edited.
//
// This lives in its own module rather than in `./index` so that other modules
// `./index` re-exports (e.g. `./daily-linkedin`) can import it without a
// circular import: `index -> daily-linkedin -> index` puts the schema in the
// temporal dead zone and throws at load. There is still exactly ONE definition
// of this shape, re-exported from `@workbench/shared` — see CL-4581 for why a
// second hand-written copy is the thing to avoid.
export const SelectedPersonSchema = type({
  refId: "string > 0",
  displayName: "string",
});
export type SelectedPerson = typeof SelectedPersonSchema.infer;
export const SelectedPersonListSchema = SelectedPersonSchema.array();
