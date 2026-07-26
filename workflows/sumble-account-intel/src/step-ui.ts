// Declarative step -> UI map (see `packages/workbench-shared/src/step-ui.ts`
// for the full contract this shape mirrors) — colocated with the workflow's
// step definitions instead of a hand-written `blocks.ts`/`ui.tsx`. `StepUIMap`
// below is a local, structural mirror of that package's `StepUI`/`StepUIEntry`
// types (types only — no runtime import), so this workflow package carries no
// dependency on `@workbench/shared` at all; the host-side derivation
// (`blocksFromStepUI` in `@workbench/blocks`) validates the map structurally
// when it consumes it.
//
// Gate → block:
//   intake — static `form` (single required `organizationDomain` text
//            field, matching the panel's dock-form behavior: the panel's
//            `pushToAttio` checkbox is intentionally NOT collected here —
//            it is optional per `SumbleIntakePayloadSchema` and defaults to
//            not pushing).
//   review — data-driven `choice` gate: `reviewGate` (this workflow's own
//            native action, see tools.ts) shapes the synthesize agent's
//            brief into a `choice` UIBlock (title + brief + contacts CSV +
//            Slack draft as the prompt, Approve/Reject as fixed options),
//            referenced here via `gateFromOutput`/`gateSourceStep`.
export const INTAKE_SIGNAL = "intake";
export const REVIEW_SIGNAL = "review";

interface StepUIInputField {
  kind: "text" | "textarea" | "number" | "select" | "multiSelect";
  name: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
}

interface StepUIEntry {
  role?: "intake" | "review" | "persist" | "display";
  title?: string;
  prompt?: string;
  submitLabel?: string;
  input?: StepUIInputField[];
  gateFromOutput?: boolean;
  gateSourceStep?: string;
}

export type StepUIMap = Record<string, StepUIEntry>;

export const STEP_UI: StepUIMap = {
  [INTAKE_SIGNAL]: {
    role: "intake",
    prompt:
      "Enter the account to research. We pull the org shape, tech stack, contacts, and buying signals, then write a reviewable brief.",
    submitLabel: "Research account",
    input: [
      {
        kind: "text",
        name: "organizationDomain",
        label: "Company domain or Sumble company ID",
        placeholder: "acme.com",
        required: true,
      },
    ],
  },
  [REVIEW_SIGNAL]: {
    role: "review",
    gateFromOutput: true,
    gateSourceStep: "reviewGate",
  },
};
