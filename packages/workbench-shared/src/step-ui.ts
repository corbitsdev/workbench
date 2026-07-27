/**
 * The `STEP_UI` contract —
 *
 * A workflow package's native definition (`defineWorkflow`, steps, `awaitSignal`
 * gates) carries zero UI metadata — that is exactly the boundary the native-action migration
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
 *
 * ## Unification with the former `StepUIHints` contract
 *
 * `@workbench/blocks` previously carried a second, competing declarative
 * contract — `StepUIHints`/`GateUIHint` — for exactly the same job (a step's
 * `awaitSignal` gate to the block that renders it), but narrower: it could
 * only declare a STATIC block (fixed at author time), so any gate whose
 * content depends on run data (options built from a prior step's fetched
 * notes, a `reviewList` over generated rows, empty-vs-unavailable branching)
 * could not be expressed by either contract. `STEP_UI` supersedes it
 * (decision (i), not (ii) — reusing `GateUIHint`/`UIBlock` directly here would
 * mean importing types from `@workbench/blocks` into this package, reversing
 * the layering this file's own placement above depends on: `@workbench/blocks`
 * carries the React/framer-motion-bound renderer and cannot be a dependency of
 * a package the hub also needs). Instead `STEP_UI` redeclares the same gate
 * vocabulary as plain, dependency-free data (`StepUIGateSchema`) and adds the
 * capability `StepUIHints` never had: `entry.gateFromOutput` lets a gate's
 * block be computed by the workflow's OWN tool code and handed across as that
 * step's (or an earlier step's, via `gateSourceStep`) output — real code, in
 * the workflow's own package, with no bespoke host-side `blocks.ts` builder
 * and no per-workflow parsing logic in `@workbench/blocks`. `StepUIHints` and
 * `blocksFromStepUIHints` are removed in the same change that introduces this;
 * `last30days-research` (its only consumer) migrates to `STEP_UI`.
 */
import { type } from "arktype";

/**
 * Sentence-cases a step id for display, matching house copy style (see
 * `references/writing-mechanics.md`): "fetch-artifact" -> "Fetch artifact",
 * never "fetch artifact". The single shared implementation — every dock-block
 * builder (`@workbench/blocks`' generic derivation, `dockRunBlocks`,
 * `gate-fallback`, and every migrated workflow's own `blocks.ts`) must call
 * this rather than pasting its own copy; that duplication is exactly what let
 * the generic `STEP_UI` derivation's casing drift from every hand-written
 * builder's. Lives here rather than `@workbench/blocks` because it is needed
 * by workflow packages too, and must stay importable without dragging in
 * `@workbench/blocks`' React/framer-motion peer deps.
 */
export function humanizeStepId(stepId: string): string {
  const words = stepId.replace(/[-_]+/gu, " ").trim();
  if (words.length === 0) return words;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What kind of gate a step plays, for host-side classification (e.g. picking
 * a form-vs-choice default, or grouping steps in a run-page timeline). Purely
 * descriptive — the derivation does not branch behavior on it beyond that. */
export const StepUIRoleSchema = type("'intake'|'review'|'persist'|'display'");
export type StepUIRole = typeof StepUIRoleSchema.infer;

export const StepUIInputFieldOptionSchema = type({
  value: "string",
  label: "string",
});
export type StepUIInputFieldOption = typeof StepUIInputFieldOptionSchema.infer;

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
  // Extra guidance shown below the label (e.g. where to find an opaque
  // pasted id) — kept OUT of `placeholder`, which must model the value's
  // shape, not carry instructions (CL-4538). Only the schedule-form surface
  // renders this today; the live dock's `form` block has no help slot yet.
  "help?": "string",
  "required?": "boolean",
  "options?": StepUIInputFieldOptionSchema.array(),
  "defaultValue?": "string | number",
  // Bounds a `number`-kind field enforces on the rendered input (CL-4538) —
  // e.g. a research-window `days` field must not accept 0 or a negative
  // count. Ignored by every other kind.
  "min?": "number",
  "max?": "number",
  "step?": "number",
});
export type StepUIInputField = typeof StepUIInputFieldSchema.infer;

/** Which block-kind renderer a completed step's output resolves to (the
 * `block-kind registry` in `@workbench/blocks`), e.g. `{ block: "reviewList" }`. */
export const StepUIOutputSchema = type({
  block: "string",
});
export type StepUIOutput = typeof StepUIOutputSchema.infer;

/** One option of a static `choice`/`multiSelect` gate. Mirrors the leaf option
 * shape both those `UIBlock` kinds share. */
export const StepUIGateOptionSchema = type({
  id: "string",
  label: "string",
  "value?": "string",
  "description?": "string",
});
export type StepUIGateOption = typeof StepUIGateOptionSchema.infer;

/**
 * A gate whose content is fixed at author time — absorbs the `choice` /
 * `multiSelect` / `redirect` gate kinds a `STEP_UI` entry can declare directly
 * (the fourth static kind, `form`, is already covered by `entry.input`). A
 * gate whose content instead depends on run data (options computed from a
 * prior step's output, a `reviewList` built from generated rows, empty-vs-
 * unavailable branching) is NOT expressible here — see `StepUIEntry.gateFromOutput`.
 */
export const StepUIGateSchema = type({
  kind: "'choice'",
  "submitLabel?": "string",
  options: StepUIGateOptionSchema.array(),
})
  .or({
    kind: "'multiSelect'",
    "submitLabel?": "string",
    "min?": "number",
    "max?": "number",
    options: StepUIGateOptionSchema.array(),
  })
  .or({
    // A fixed run-page redirect (e.g. a gate whose real affordance is a join
    // no dock primitive can express) — the same block
    // `runPageRedirectBlock` renders, just declared as data instead of code.
    kind: "'redirect'",
    title: "string",
    description: "string",
  });
export type StepUIGate = typeof StepUIGateSchema.infer;

export const StepUIEntrySchema = type({
  "role?": StepUIRoleSchema,
  "title?": "string",
  // A gate's prompt/submitLabel default to `title` when unset; set them
  // explicitly when the gate's copy needs to differ from its progress label
  // (e.g. a longer question than the short label shown in the run timeline).
  "prompt?": "string",
  "submitLabel?": "string",
  "input?": StepUIInputFieldSchema.array(),
  "output?": StepUIOutputSchema,
  // Static gate content (choice/multiSelect/redirect) — mutually exclusive
  // with `input`; a workflow authoring both is a schema error at review time,
  // not one this schema enforces (arktype has no XOR discriminant here).
  "gate?": StepUIGateSchema,
  // Dynamic gate content: this gate's block is a PRIOR (or this) step's own
  // OUTPUT — a `UIBlock` already fully computed by the workflow's own tool
  // (e.g. a `choice` built from fetched notes, a `reviewList` over generated
  // rows, or a `gateFallbackBlock`-shaped `error`/`text`/`link` for the empty/
  // unavailable/failed cases) with `signalName` omitted or ignored — the host
  // stamps the run's live signal name onto gate-capable kinds and passes
  // fallback-shaped kinds through unchanged. This is how a data-driven gate
  // (options-from-notes, computed defaults, per-record review rows) is
  // expressed without any per-workflow `blocks.ts` builder.
  //
  // CONTRACT, easy to miss when migrating a workflow: setting `gateFromOutput`
  // on a gate changes the OUTPUT SCHEMA of its source step (`gateSourceStep`,
  // or the gating step itself when omitted) from whatever raw domain shape the
  // tool used to return (e.g. `{ notes: [...] }`) to a `UIBlock`-shaped value
  // (`{ kind: "choice", ... }` / `{ kind: "reviewList", ... }` / etc.) —
  // `@workbench/blocks`' `dynamicGateBlock` requires
  // `run.stepOutputs[sourceStepId]` to already satisfy `isUIBlock`, and treats
  // anything else as "not resolvable yet," falling back to the generic
  // run-page redirect. That is a real relocation of a step's output shape, not
  // just an additive change — anything that read the source step's RAW output
  // before this migration breaks silently (it now sees UI-shaped JSON).
  //
  // Open question this leaves for the FIRST migration that hits it: if a
  // DOWNSTREAM step also needs the raw domain data from that source step (not
  // just its UI rendering), this contract does not solve that for you. Either
  // unwrap the `UIBlock` back to the domain shape in that downstream step, or
  // keep a separate step that still emits the raw data alongside the
  // UI-shaping one. No mechanism for this exists yet — decide deliberately
  // rather than discovering it at runtime.
  "gateFromOutput?": "boolean",
  // Which step's decoded output supplies the gate block when `gateFromOutput`
  // is set. Defaults to the gating step's own id when omitted — set this when
  // the gate's content comes from an EARLIER step (e.g. a `review` gate whose
  // rows were computed by the `generate` step, while `review` itself is still
  // PENDING, not completed).
  "gateSourceStep?": "string",
});
export type StepUIEntry = typeof StepUIEntrySchema.infer;

/** A workflow's declarative step -> UI map, keyed by the native step id
 * (the same key used in `defineWorkflow({ steps: { ... } })`). */
export const StepUISchema = type({
  "[string]": StepUIEntrySchema,
});
export type StepUI = typeof StepUISchema.infer;

/**
 * Build-time guard: every `STEP_UI` key must name a real step id in the
 * workflow's own `defineWorkflow({ steps: {...} })`. Without this, renaming a
 * step silently orphans its `STEP_UI` entry — the derivation just falls back
 * to the generic default for the renamed id and never tells anyone the old
 * entry stopped applying. Call this from the workflow package's own test
 * suite with `Object.keys(workflow.steps)` (or equivalent) — it belongs there,
 * not here, since only the workflow package has both `STEP_UI` and the real
 * step id list in scope.
 */
export function assertStepUIKeysMatchStepIds(
  stepUI: StepUI,
  stepIds: readonly string[],
): void {
  const known = new Set(stepIds);
  const unknownKeys = Object.keys(stepUI).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `STEP_UI declares entries for unknown step id(s): ${unknownKeys.join(", ")}. Every STEP_UI key must match a real step id in the workflow definition.`,
    );
  }
}

/**
 * Build-time guard, the other direction from `assertStepUIKeysMatchStepIds`:
 * every GATE step (an `awaitSignal` primitive — a user-facing moment the run
 * parks on until a human resumes it) must have a `STEP_UI` entry.
 *
 * A non-gate step with no entry is fine and expected: `blocksFromStepUI` falls
 * back to a humanized progress-row label, which is a reasonable default for an
 * internal step nobody needs to author copy for. A GATE with no entry is a
 * different failure mode — it silently falls through to
 * `genericGateFallback`'s "This run needs input the dock cannot collect yet"
 * run-page redirect, which is a real UX degradation for a moment the workflow
 * author meant a human to act on, and it degrades with no build-time signal:
 * the run still "works," it just ships worse copy nobody wrote or reviewed.
 * That silent-degradation risk (not general completeness) is why gates alone
 * are enforced here and every other step is deliberately left optional.
 *
 * Call this from the workflow package's own test suite alongside
 * `assertStepUIKeysMatchStepIds`, passing the gate step ids computed from
 * `workflow.steps` (steps whose primitive `kind` is `"awaitSignal"`) — the
 * same place that already has both `STEP_UI` and the real step definitions in
 * scope, and the same place with the correct env/test setup already wired for
 * importing that workflow's own module.
 */
export function assertGateStepsHaveStepUIEntry(
  stepUI: StepUI,
  gateStepIds: readonly string[],
): void {
  const missing = gateStepIds.filter((stepId) => stepUI[stepId] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `STEP_UI is missing entries for gate step id(s): ${missing.join(", ")}. Every awaitSignal (gate) step needs a STEP_UI entry — without one it silently falls back to the generic run-page redirect instead of the copy its author intended.`,
    );
  }
}
