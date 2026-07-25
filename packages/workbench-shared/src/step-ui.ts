/**
 * The `STEP_UI` contract (CL-4515).
 *
 * A workflow package's native definition (`defineWorkflow`, steps, `awaitSignal`
 * gates) carries zero UI metadata — that is exactly the boundary CL-4454
 * restores. `STEP_UI` is the one optional, sibling export a workflow may add
 * next to `workflow` to steer how the host renders its dock UI, without
 * putting rendering hints on any native primitive (`StepPrimitive`,
 * `ActionPrimitive`, `AwaitSignalPrimitive` have no metadata slot, and tags are
 * exactly the mistake this ticket undoes).
 *
 * Kept here — `packages/workbench-shared` — rather than `@workbench/blocks`
 * because it must be readable by both the hub (backend, no React) and the web
 * app (the actual dock host) without dragging `@workbench/blocks`' React/
 * framer-motion peer deps into a package that cannot take them. The
 * `UIBlock`-shaped DERIVATION that reads this map (`blocksFromStepUI`) stays in
 * `@workbench/blocks`, next to the generic helpers it reuses
 * (`pendingGateForRun`, `progressStateForStepPhase`); this file is pure data.
 *
 * Every field is optional. A step absent from the map — or a workflow with no
 * `STEP_UI` export at all — renders with the same generic defaults
 * `dockRunBlocks` already produces today.
 */
import { type } from "arktype";

/** What kind of gate a step plays, for host-side classification (e.g. picking
 * a form-vs-choice default, or grouping steps in a run-page timeline). Purely
 * descriptive — the derivation does not branch behavior on it beyond that. */
export const StepUIRoleSchema = type(
  "'intake'|'review'|'persist'|'display'",
);
export type StepUIRole = typeof StepUIRoleSchema.infer;

export const StepUIInputFieldOptionSchema = type({
  value: "string",
  label: "string",
});
export type StepUIInputFieldOption =
  typeof StepUIInputFieldOptionSchema.infer;

/**
 * One field of a step's `input` form. Mirrors the leaf-field subset of
 * `@workbench/blocks`' `FormField` (text/textarea/number/select/multiSelect) —
 * intentionally excludes the recursive `group` kind, which no workflow's
 * `STEP_UI` needs yet; add it here if a repeatable-row intake gate arrives.
 */
export const StepUIInputFieldSchema = type({
  kind: "'text'|'textarea'|'number'|'select'|'multiSelect'",
  name: "string",
  "label?": "string",
  "placeholder?": "string",
  "required?": "boolean",
  "options?": StepUIInputFieldOptionSchema.array(),
});
export type StepUIInputField = typeof StepUIInputFieldSchema.infer;

/** Which block-kind renderer a completed step's output resolves to (the
 * `block-kind registry` in `@workbench/blocks`), e.g. `{ block: "reviewList" }`. */
export const StepUIOutputSchema = type({
  block: "string",
});
export type StepUIOutput = typeof StepUIOutputSchema.infer;

export const StepUIEntrySchema = type({
  "role?": StepUIRoleSchema,
  "title?": "string",
  "input?": StepUIInputFieldSchema.array(),
  "output?": StepUIOutputSchema,
});
export type StepUIEntry = typeof StepUIEntrySchema.infer;

/** A workflow's declarative step -> UI map, keyed by the native step id
 * (the same key used in `defineWorkflow({ steps: { ... } })`). */
export const StepUISchema = type({
  "[string]": StepUIEntrySchema,
});
export type StepUI = typeof StepUISchema.infer;
