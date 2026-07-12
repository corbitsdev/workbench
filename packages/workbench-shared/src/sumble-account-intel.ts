import { type } from "arktype";

// Resume-boundary contracts for the sumble-account-intel workflow's two HITL
// gates. Both the block-driven dock surface (`blocks.ts`) and the run-page panel
// (`ui.tsx`) POST these shapes; registering them pulls each gate's
// completeness/shape invariant to the /resume boundary so a malformed payload is
// rejected with 400 instead of poisoning the downstream steps that read it.

// A non-empty account identifier (a company domain or a Sumble slug). Every
// downstream Sumble call and the artifact title derive from it, so a blank value
// would resolve no organization — reject it at the boundary.
export const SumbleOrganizationDomainSchema = type("string").narrow(
  (value) => value.trim().length > 0,
);

// `intake`: the account to research. `organizationDomain` is REQUIRED and
// non-empty (a company domain or Sumble slug); `pushToAttio` is an optional flag
// carried through to the review gate so the operator can request a CRM note.
export const SumbleIntakePayloadSchema = type({
  organizationDomain: SumbleOrganizationDomainSchema,
  "pushToAttio?": "boolean",
});
export type SumbleIntakePayload = typeof SumbleIntakePayloadSchema.infer;

// `review`: the operator approves the synthesized brief before it is persisted.
// `approved` is required; `pushToAttio` re-affirms (or overrides) the intake flag
// at approval time.
export const SumbleReviewPayloadSchema = type({
  approved: "boolean",
  "pushToAttio?": "boolean",
});
export type SumbleReviewPayload = typeof SumbleReviewPayloadSchema.infer;
