import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn, ComparisonView, Markdown, PulsingRing } from "@workbench/ui";
import {
  CardBlock,
  ListBlock,
  PreviewBlock,
  isSafeLinkHref,
} from "./display-blocks";
import {
  MAX_UI_BLOCK_NEST_DEPTH,
  type FormField,
  type ProgressStepState,
  type ReviewListDisplayField,
  type UIBlock,
  type UIResponse,
} from "./ui-block";

/**
 * The generative-UI registry: the single switch that turns a typed UIBlock into
 * a rendered component. Adding a block type = one variant in the union + one
 * case here. Interactive blocks (choice) call `onRespond`, which the host wires
 * to "send a new user turn", closing the agent loop.
 */
export interface UIBlockViewProps {
  block: UIBlock;
  /** Canvas recursion guard; callers should not set this. */
  depth?: number;
  /**
   * Invoked when an interactive block produces a response to send to the agent.
   * May return a promise (the host's resume mutation) — interactive blocks await
   * it and only mark themselves submitted on success, so a failed resume keeps
   * the user's input intact for a retry (CL-2684).
   */
  onRespond?: ((response: UIResponse) => void | Promise<void>) | undefined;
  /** Invoked for document actions (copy / download / save-artifact). */
  onAction?:
    | ((action: "copy" | "download" | "save-artifact", block: UIBlock) => void)
    | undefined;
}

function formatTableCell(cell: string | number | boolean): string {
  return typeof cell === "string" ? cell : String(cell);
}

export function UIBlockView({
  block,
  onRespond,
  onAction,
  depth = 0,
}: UIBlockViewProps) {
  if (depth > MAX_UI_BLOCK_NEST_DEPTH) {
    return (
      <p className="text-sm text-text-3">
        This UI block could not be displayed (nesting limit).
      </p>
    );
  }
  switch (block.kind) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm text-text-2">
          {block.text}
        </p>
      );
    case "markdown":
      return <MarkdownBlock block={block} />;
    case "document":
      return (
        <DocumentBlock
          block={block}
          {...(onAction !== undefined ? { onAction } : {})}
        />
      );
    case "table":
      return <TableBlock block={block} />;
    case "link":
      return <LinkBlock block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
    case "choice":
      return (
        <ChoiceBlock
          block={block}
          {...(onRespond !== undefined ? { onRespond } : {})}
        />
      );
    case "progress":
      return <ProgressBlock block={block} />;
    case "form":
      return (
        <FormBlock
          block={block}
          {...(onRespond !== undefined ? { onRespond } : {})}
        />
      );
    case "multiSelect":
      return (
        <MultiSelectBlock
          block={block}
          {...(onRespond !== undefined ? { onRespond } : {})}
        />
      );
    case "reviewList":
      return (
        <ReviewListBlock
          block={block}
          {...(onRespond !== undefined ? { onRespond } : {})}
        />
      );
    case "comparison":
      return (
        <ComparisonView
          result={block.result}
          status={block.status}
          blind={block.blind ?? false}
        />
      );
    case "card":
      return <CardBlock block={block} />;
    case "list":
      return <ListBlock block={block} />;
    case "preview":
      return <PreviewBlock block={block} />;
    case "canvas":
      return (
        <div className="space-y-3" data-testid="ui-canvas">
          {block.title !== undefined && (
            <h3 className="text-sm font-semibold text-text">{block.title}</h3>
          )}
          {block.blocks.map((child, index) => (
            <UIBlockView
              key={index}
              block={child}
              depth={depth + 1}
              onRespond={onRespond}
              onAction={onAction}
            />
          ))}
        </div>
      );
  }
}

function Surface({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface-2", className)}
    >
      {children}
    </div>
  );
}

// A live, animated spinner shown while a submit awaits the host resume (CL-2684).
// The animation is the point: a frozen "Submitting…" reads as a stalled UI, so
// the indicator must visibly move for the whole in-flight window.
function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

// The legible, retryable failure line shown inline on a block whose submit was
// rejected by the host (CL-2684): the form/selection stays populated so the user
// can fix and resubmit without re-typing.
function SubmitError({ message }: { message: string }) {
  return (
    <p className="text-xs text-red" role="alert">
      {message}
    </p>
  );
}

// The host resume rejects with an Error; surface its message when it carries one,
// otherwise a plain-language fallback (never a raw code).
function submitErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Couldn't send your response. Please try again.";
}

function MarkdownBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "markdown" }>;
}) {
  const [open, setOpen] = useState(!(block.collapsible ?? false));
  return (
    <Surface className="overflow-hidden">
      {block.title !== undefined && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-text-2"
        >
          {block.title}
          {block.collapsible === true && (
            <span className="text-text-3">{open ? "−" : "+"}</span>
          )}
        </button>
      )}
      {open && <Markdown className="px-3 pb-3">{block.source}</Markdown>}
    </Surface>
  );
}

function DocumentBlock({
  block,
  onAction,
}: {
  block: Extract<UIBlock, { kind: "document" }>;
  onAction?: (
    action: "copy" | "download" | "save-artifact",
    block: UIBlock,
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = block.actions ?? { copy: true };
  const actionList: {
    key: "copy" | "download" | "save-artifact";
    label: string;
  }[] = [];
  if (actions.copy === true) actionList.push({ key: "copy", label: "Copy" });
  if (actions.download === true)
    actionList.push({ key: "download", label: "Download" });
  if (actions.saveArtifact === true)
    actionList.push({ key: "save-artifact", label: "Save to artifacts" });

  return (
    <Surface>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        <span
          className={cn(
            "text-text-3 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-text">
            {block.title}
          </span>
          {block.subtitle !== undefined && (
            <span className="block truncate text-xs text-text-3">
              {block.subtitle}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-text-3">
          {open ? "Hide" : "Open"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border">
          <Markdown className="max-h-96 overflow-auto px-4 py-3">
            {block.source}
          </Markdown>
          {actionList.length > 0 && (
            <div className="flex gap-2 border-t border-border px-3 py-2">
              {actionList.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  onClick={() => onAction?.(action.key, block)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs text-text-2 hover:bg-row-hover hover:text-text"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Surface>
  );
}

function TableBlock({ block }: { block: Extract<UIBlock, { kind: "table" }> }) {
  return (
    <Surface className="overflow-hidden">
      {block.title !== undefined && (
        <div className="px-3 py-2 text-sm font-medium text-text-2">
          {block.title}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-border text-xs text-text-3">
              {block.columns.map((column) => (
                <th key={column} className="px-3 py-1.5 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className="border-b border-border last:border-0 hover:bg-row-hover"
              >
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-1.5 text-text">
                    {formatTableCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}

function LinkBlock({ block }: { block: Extract<UIBlock, { kind: "link" }> }) {
  if (!isSafeLinkHref(block.url)) {
    return (
      <span className="text-sm text-text-2">{block.title ?? block.url}</span>
    );
  }
  return (
    <a
      href={block.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5 hover:border-border-strong"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text">
          {block.title ?? block.url}
        </span>
        {block.description !== undefined && (
          <span className="block truncate text-xs text-text-3">
            {block.description}
          </span>
        )}
      </span>
    </a>
  );
}

function ErrorBlock({ block }: { block: Extract<UIBlock, { kind: "error" }> }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
      <span className="font-medium">{block.message}</span>
      {block.detail !== undefined && (
        <pre className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">
          {block.detail}
        </pre>
      )}
    </div>
  );
}

/**
 * The state a step renders with. Encodes the "step is done once completed OR
 * any later step started" rule from packages/ui workflow-run-state.tsx
 * (CL-2506): an awaitSignal gate's completion can be missing from the emitted
 * snapshot, so a stale non-terminal step is shown done once a later step has
 * progressed. A failed step is NEVER re-labeled — independent DAG branches run
 * concurrently, so later progress says nothing about the failure (CL-2654).
 */
function effectiveStepState(
  steps: readonly { state: ProgressStepState }[],
  index: number,
): ProgressStepState {
  const step = steps[index];
  if (step === undefined) return "pending";
  if (step.state === "done" || step.state === "failed") return step.state;
  // A later FAILED step is excluded from the promotion predicate (CL-2654):
  // independent DAG branches run concurrently, so a failure downstream says
  // nothing about whether this step actually completed — promoting an
  // awaiting/running step to done on a later failure would rewind the truth.
  const laterStarted = steps
    .slice(index + 1)
    .some((later) => later.state !== "pending" && later.state !== "failed");
  if (laterStarted) return "done";
  return step.state;
}

// Screen-reader-only status word for each step state. Visually the state is
// carried by the rail/indicator + motion, not a right-aligned word — the flat
// checklist read as a debug view (CL-4394). The word survives for a11y and is
// queryable by text-based tests even though it renders visually hidden.
const STEP_STATE_LABEL: Record<ProgressStepState, string> = {
  done: "Done",
  running: "In progress",
  awaiting: "Needs your input",
  pending: "Up next",
  failed: "Failed",
};

// The rail segment BELOW a step is "filled" once that step is done — it
// visually connects to the step below only when this step's own work has
// actually landed, so the flowing highlight never runs ahead of real progress.
function railSegmentFilled(state: ProgressStepState): boolean {
  return state === "done";
}

function StepIndicator({
  state,
  index,
  reduceMotion,
}: {
  state: ProgressStepState;
  index: number;
  reduceMotion: boolean;
}) {
  const base =
    "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-semibold";
  if (state === "done") {
    return (
      <motion.span
        className={cn(base, "bg-green text-white")}
        initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
      >
        ✓
      </motion.span>
    );
  }
  if (state === "failed") {
    return <span className={cn(base, "bg-red text-white")}>!</span>;
  }
  if (state === "running") {
    return (
      <span className={cn(base, "border-2 border-blue")} aria-hidden>
        <PulsingRing colorClassName="bg-blue/25" reduceMotion={reduceMotion} />
        <span className="h-2 w-2 rounded-full bg-blue" />
      </span>
    );
  }
  if (state === "awaiting") {
    // Passive status, not a CTA: awaiting steps use the neutral Summit Blue
    // status token, never the orange ACTION token (CL-2683). The choice BUTTON
    // stays orange — that is the actionable affordance. Filled (not hollow)
    // and static so it reads distinct from the pulsing hollow "running" ring
    // at 24px (CL-4394).
    return (
      <span className={cn(base, "bg-blue-soft text-blue-deep")}>
        {index + 1}
      </span>
    );
  }
  return (
    <span className={cn(base, "border-2 border-border text-text-3")}>
      {index + 1}
    </span>
  );
}

function ProgressBlock({
  block,
}: {
  block: Extract<UIBlock, { kind: "progress" }>;
}) {
  const reduceMotion = useReducedMotion() === true;
  const total = block.steps.length;
  const doneCount = block.steps.filter(
    (_, index) => effectiveStepState(block.steps, index) === "done",
  ).length;

  return (
    <Surface className="px-3 py-3">
      {(block.title !== undefined || total > 1) && (
        <div className="flex items-baseline justify-between gap-2 pb-3">
          {block.title !== undefined && (
            <span className="text-sm font-medium text-text-2">
              {block.title}
            </span>
          )}
          {total > 1 && (
            <span className="shrink-0 text-sm text-text-3">
              {doneCount} of {total}
            </span>
          )}
        </div>
      )}
      <ol className="relative" aria-live="polite">
        {block.steps.map((step, index) => {
          const state = effectiveStepState(block.steps, index);
          const isLast = index === block.steps.length - 1;
          return (
            <motion.li
              key={index}
              layout={reduceMotion ? false : "position"}
              data-state={state}
              aria-current={state === "running" ? "step" : undefined}
              className={cn("flex gap-3", state === "pending" && "opacity-45")}
            >
              {/* Icon column stretches (flex default align-items) to match the
                  label column's height, including the label column's own
                  bottom padding — that padding IS the visual gap to the next
                  step, so the rail (filling the icon column below the
                  indicator) reaches all the way into it. A percentage height
                  on the rail itself would not work here: percentage heights
                  only resolve against an ancestor with a definite (non-auto)
                  height, which this auto-sized row never has. */}
              <div className="flex flex-col items-center">
                <StepIndicator
                  state={state}
                  index={index}
                  reduceMotion={reduceMotion}
                />
                {!isLast && (
                  <span
                    data-rail="true"
                    className={cn(
                      "mt-1 w-0.5 flex-1 rounded-full transition-colors duration-300",
                      railSegmentFilled(state) ? "bg-green" : "bg-border",
                    )}
                    aria-hidden
                  />
                )}
              </div>
              <span
                className={cn(
                  "min-w-0 flex-1 pt-0.5",
                  isLast ? "pb-0" : "pb-5",
                )}
              >
                <span
                  className={cn(
                    "block truncate text-sm",
                    state === "failed" && "text-red",
                    state === "running" && "font-medium text-text",
                    state !== "failed" && state !== "running" && "text-text-2",
                  )}
                >
                  {step.label ?? `Step ${index + 1}`}
                </span>
                {step.meta !== undefined && (
                  <span className="block truncate text-xs text-text-3">
                    {step.meta}
                  </span>
                )}
                <span className="sr-only">{STEP_STATE_LABEL[state]}</span>
              </span>
            </motion.li>
          );
        })}
      </ol>
    </Surface>
  );
}

// A leaf field's controlled state: a string for text/textarea/number/select, a
// string[] for a multiSelect field. Group rows are arrays of these.
type LeafValue = string | string[];
type FieldValue = LeafValue | Record<string, LeafValue>[];
type LeafField = Exclude<FormField, { kind: "group" }>;

function leafInitialValue(field: LeafField): LeafValue {
  if (field.kind === "multiSelect") {
    return (field.options || [])
      .filter((o) => o.defaultChecked === true)
      .map((o) => o.value);
  }
  if (field.kind === "number") {
    return field.defaultValue === undefined ? "" : String(field.defaultValue);
  }
  return field.defaultValue ?? "";
}

function effectiveGroupMin(min: number | undefined): number {
  if (min === undefined) return 1;
  return Math.max(min, 0);
}

function initialValue(field: FormField): FieldValue {
  if (field.kind === "group") {
    if (Array.isArray(field.defaultRows) && field.defaultRows.length > 0) {
      return field.defaultRows.map((seed) =>
        seededRow(field.fields, seed as Record<string, unknown>),
      );
    }
    const rowCount = effectiveGroupMin(field.min);
    return Array.from({ length: rowCount }, () => emptyRow(field.fields));
  }
  return leafInitialValue(field);
}

function emptyRow(fields: LeafField[]): Record<string, LeafValue> {
  const row: Record<string, LeafValue> = {};
  for (const field of fields) row[field.name] = leafInitialValue(field);
  return row;
}

// Coerce a pre-seeded `defaultRows` row (which may carry raw typed values from a
// prior step — e.g. a number for a `number` cell) into the string / string[]
// state shape every cell renderer and `leafToPayload` assume. A missing cell
// falls back to its own default; without this a numeric cell reaches
// `leafToPayload` as a number and throws on `.trim()` (CL-2773 review).
function seededRow(
  fields: LeafField[],
  seed: Record<string, unknown>,
): Record<string, LeafValue> {
  const row: Record<string, LeafValue> = {};
  for (const field of fields) {
    const value = seed[field.name];
    if (value === undefined || value === null) {
      row[field.name] = leafInitialValue(field);
    } else if (field.kind === "multiSelect") {
      row[field.name] = Array.isArray(value)
        ? value.map((entry) => String(entry))
        : leafInitialValue(field);
    } else {
      row[field.name] = String(value);
    }
  }
  return row;
}

function leafFilled(field: LeafField, value: LeafValue): boolean {
  if (field.kind === "multiSelect") {
    const selected = Array.isArray(value) ? value : [];
    const min =
      field.required === true
        ? Math.max(field.min ?? 1, 1)
        : Math.max(field.min ?? 0, 0);
    if (field.required !== true) {
      if (selected.length === 0) return true;
      return selected.length >= min;
    }
    return selected.length >= min;
  }
  if (field.required !== true) return true;
  if (field.kind === "number") {
    // A required number must parse to a real number: a non-empty but
    // non-numeric entry (e.g. "abc") is NaN and must NOT satisfy the field, or
    // submit would enable on a value leafToPayload then drops (CL-2684).
    if (typeof value !== "string" || value.trim().length === 0) return false;
    return !Number.isNaN(Number(value));
  }
  return typeof value === "string" && value.trim().length > 0;
}

function fieldSatisfied(field: FormField, value: FieldValue): boolean {
  if (field.kind !== "group") return leafFilled(field, value as LeafValue);
  const rows = value as Record<string, LeafValue>[];
  if (rows.length < effectiveGroupMin(field.min)) return false;
  return rows.every((row) =>
    field.fields.every((sub) => leafFilled(sub, row[sub.name] ?? "")),
  );
}

// Empty optional fields are DROPPED from the payload rather than emitted as ""
// (CL-2684): a downstream step that field-reads an optional (e.g. gamma intake's
// artifactId/noteId) must see a missing key, not a blank that fires a wasted
// lookup or injects an empty labeled value into a prompt. Required fields are
// held non-empty by the submit gate, so they are never dropped here.
function leafToPayload(field: LeafField, value: LeafValue): unknown {
  if (field.kind === "multiSelect") {
    const selected = value as string[];
    return selected.length === 0 ? undefined : selected;
  }
  if (field.kind === "number") {
    const text = value as string;
    if (text.trim().length === 0) return undefined;
    // A non-numeric entry parses to NaN — omit it rather than emit NaN, which
    // serializes to null and corrupts the downstream payload (CL-2684). A
    // required number field is held non-empty AND non-NaN by leafFilled.
    const parsed = Number(text);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const text = value as string;
  return text.trim().length === 0 ? undefined : text;
}

function fieldToPayload(field: FormField, value: FieldValue): unknown {
  if (field.kind !== "group") return leafToPayload(field, value as LeafValue);
  const rows = value as Record<string, LeafValue>[];
  if (rows.length === 0) return undefined;
  return rows.map((row) => {
    const entry: Record<string, unknown> = {};
    for (const sub of field.fields) {
      const converted = leafToPayload(sub, row[sub.name] ?? "");
      if (converted !== undefined) entry[sub.name] = converted;
    }
    return entry;
  });
}

/**
 * A textarea that grows with its content, then scrolls. On each value change it
 * collapses to `auto` to remeasure true content height and pins the inline
 * height to `scrollHeight`; a CSS `max-h` clamps the visible box, so once the
 * content exceeds the ceiling the box stops growing and scrolls internally
 * instead of pushing the page past the viewport (CL-3234).
 */
function AutoGrowTextarea({
  value,
  onChange,
  placeholder,
  minRows,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string | undefined;
  minRows: number;
  className: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const lastWidth = useRef<number>(0);
  // Collapse to remeasure, then grow to fit. `minHeight` holds the floor at
  // `minRows`, so an empty box never shrinks below its initial rows.
  const fit = useCallback(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    lastWidth.current = el.clientWidth;
  }, []);
  useLayoutEffect(() => {
    fit();
  }, [value, fit]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    // Width changes (window/container resize) rewrap the text and change the
    // content height, so remeasure on resize. Gate on width only — our own
    // height writes must not re-trigger a fit and loop the observer.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth.current) return;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  return (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      rows={minRows}
      onChange={(event) => onChange(event.target.value)}
      // Floor at `minRows`, derived from the shared `text-sm` (1.25rem line
      // height) + `py-2` (1rem) + 1px border box the input class renders.
      style={{ minHeight: `calc(${minRows} * 1.25rem + 1rem + 2px)` }}
      className={cn(className, "max-h-[40vh] resize-none overflow-y-auto")}
    />
  );
}

function LeafFieldInput({
  field,
  value,
  onChange,
}: {
  field: LeafField;
  value: LeafValue;
  onChange: (next: LeafValue) => void;
}) {
  const inputClass =
    "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40";
  const labelNode =
    field.label !== undefined ? (
      <span className="mb-1 block text-xs font-medium text-text-2">
        {field.label}
        {field.required === true && <span className="text-orange"> *</span>}
      </span>
    ) : null;

  if (field.kind === "textarea") {
    return (
      <label className="block">
        {labelNode}
        <AutoGrowTextarea
          value={value as string}
          placeholder={field.placeholder}
          minRows={3}
          onChange={onChange}
          className={inputClass}
        />
      </label>
    );
  }
  if (field.kind === "select") {
    return (
      <label className="block">
        {labelNode}
        <select
          value={value as string}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        >
          <option value="">Select…</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (field.kind === "multiSelect") {
    const selected = value as string[];
    const atMax = field.max !== undefined && selected.length >= field.max;
    return (
      <fieldset>
        {labelNode}
        <div className="space-y-1.5">
          {field.options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex items-start gap-2 text-sm text-text"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atMax}
                  onChange={() =>
                    onChange(
                      checked
                        ? selected.filter((v) => v !== option.value)
                        : [...selected, option.value],
                    )
                  }
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block">{option.label}</span>
                  {option.description !== undefined && (
                    <span className="block text-xs text-text-3">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }
  return (
    <label className="block">
      {labelNode}
      <input
        type={field.kind === "number" ? "number" : "text"}
        value={value as string}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </label>
  );
}

function FormBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "form" }>;
  onRespond?: (response: UIResponse) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {};
    for (const field of block.fields) initial[field.name] = initialValue(field);
    return initial;
  });
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (submitted) {
    return <p className="text-xs italic text-text-3">Submitted.</p>;
  }

  const complete = block.fields.every((field) =>
    fieldSatisfied(field, values[field.name] ?? initialValue(field)),
  );

  function setLeaf(name: string, next: LeafValue) {
    setValues((prev) => ({ ...prev, [name]: next }));
  }

  function setRowLeaf(
    groupName: string,
    rowIndex: number,
    fieldName: string,
    next: LeafValue,
  ) {
    setValues((prev) => {
      const rows = [
        ...((prev[groupName] as Record<string, LeafValue>[]) ?? []),
      ];
      rows[rowIndex] = { ...rows[rowIndex], [fieldName]: next };
      return { ...prev, [groupName]: rows };
    });
  }

  async function submit() {
    if (pending) return;
    const payload: Record<string, unknown> = {};
    for (const field of block.fields) {
      const converted = fieldToPayload(
        field,
        values[field.name] ?? initialValue(field),
      );
      if (converted !== undefined) payload[field.name] = converted;
    }
    setError(null);
    setPending(true);
    try {
      await onRespond?.({
        blockKind: "form",
        value: "",
        ...(block.signalName !== undefined
          ? { signalName: block.signalName }
          : {}),
        payload,
      });
      // Only collapse the form once the host confirms the response landed — on
      // failure the populated fields survive for a retry (CL-2684).
      setSubmitted(true);
    } catch (err: unknown) {
      setError(submitErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface className="space-y-3 px-3 py-3">
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      {block.fields.map((field) => {
        if (field.kind !== "group") {
          return (
            <LeafFieldInput
              key={field.name}
              field={field}
              value={(values[field.name] as LeafValue) ?? ""}
              onChange={(next) => setLeaf(field.name, next)}
            />
          );
        }
        const rows = (values[field.name] as Record<string, LeafValue>[]) ?? [];
        const atMax = field.max !== undefined && rows.length >= field.max;
        const atMin = rows.length <= effectiveGroupMin(field.min);
        return (
          <fieldset key={field.name} className="space-y-2">
            {field.label !== undefined && (
              <legend className="text-xs font-medium text-text-2">
                {field.label}
              </legend>
            )}
            {rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className="space-y-2 rounded-lg border border-border p-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-3">#{rowIndex + 1}</span>
                  {!atMin && (
                    <button
                      type="button"
                      onClick={() =>
                        setValues((prev) => ({
                          ...prev,
                          [field.name]: (
                            prev[field.name] as Record<string, LeafValue>[]
                          ).filter((_, index) => index !== rowIndex),
                        }))
                      }
                      className="text-xs text-text-3 hover:text-red"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {field.fields.map((sub) => (
                  <LeafFieldInput
                    key={sub.name}
                    field={sub}
                    value={row[sub.name] ?? ""}
                    onChange={(next) =>
                      setRowLeaf(field.name, rowIndex, sub.name, next)
                    }
                  />
                ))}
              </div>
            ))}
            {!atMax && (
              <button
                type="button"
                onClick={() =>
                  setValues((prev) => ({
                    ...prev,
                    [field.name]: [
                      ...((prev[field.name] as Record<string, LeafValue>[]) ??
                        []),
                      emptyRow(field.fields),
                    ],
                  }))
                }
                className="rounded-lg border border-border px-2.5 py-1 text-xs text-text-2 hover:border-orange hover:text-orange"
              >
                {field.addLabel ?? "Add"}
              </button>
            )}
          </fieldset>
        );
      })}
      {error !== null && <SubmitError message={error} />}
      <button
        type="button"
        disabled={!complete || pending}
        onClick={() => {
          void submit();
        }}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text transition-transform hover:border-orange hover:text-orange active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
      >
        {pending && <Spinner />}
        {pending ? "Submitting…" : (block.submitLabel ?? "Submit")}
      </button>
    </Surface>
  );
}

function MultiSelectBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "multiSelect" }>;
  onRespond?: (response: UIResponse) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>(() =>
    block.options
      .filter((o) => o.defaultChecked === true)
      .map((o) => o.value ?? o.label),
  );
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onRespond?.({
        blockKind: "multiSelect",
        value: selected.join(", "),
        ...(block.signalName !== undefined
          ? { signalName: block.signalName }
          : {}),
        payload: selected,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(submitErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <p className="text-xs italic text-text-3">
        You selected: {selected.join(", ")}
      </p>
    );
  }

  const min = Math.max(block.min ?? 1, 0);
  const atMax = block.max !== undefined && selected.length >= block.max;
  const inRange =
    selected.length >= min &&
    (block.max === undefined || selected.length <= block.max);

  return (
    <div className="space-y-2">
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      <div className="space-y-1.5">
        {block.options.map((option) => {
          const optionValue = option.value ?? option.label;
          const checked = selected.includes(optionValue);
          return (
            <label
              key={option.id}
              className="flex items-start gap-2 text-sm text-text"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && atMax}
                onChange={() =>
                  setSelected((prev) =>
                    checked
                      ? prev.filter((v) => v !== optionValue)
                      : [...prev, optionValue],
                  )
                }
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block">{option.label}</span>
                {option.description !== undefined && (
                  <span className="block text-xs text-text-3">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {error !== null && <SubmitError message={error} />}
      <button
        type="button"
        disabled={!inRange || pending}
        onClick={() => {
          void submit();
        }}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text transition-transform hover:border-orange hover:text-orange active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
      >
        {pending && <Spinner />}
        {pending ? "Submitting…" : (block.submitLabel ?? "Submit")}
      </button>
    </div>
  );
}

// Spread the row's FULL verbatim payload flat and stamp the human's verdict
// (CL-2759). A non-object payload (a bare string/number) can't be spread, so it
// is nested under a `payload` key rather than dropped — the downstream step
// still gets the record plus `approved`. The verdict `approved` is written LAST
// and intentionally overrides any `approved` field the payload itself carries:
// the three consumers use `approved` as the canonical decision key by design.
function decisionEntry(payload: unknown, approved: boolean): unknown {
  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
  ) {
    return { ...(payload as Record<string, unknown>), approved };
  }
  return { payload, approved };
}

// The helper line shown when submit is held because the approved count sits
// outside [min, max] (CL-2759) — so a disabled submit is never a silent dead
// button. Null when the count is already in range.
function rangeHintFor(count: number, min: number, max: number): string | null {
  if (count >= min && count <= max) return null;
  if (count < min) return `Approve at least ${min} to continue.`;
  return `Approve at most ${max} to continue.`;
}

function ReviewListCell({
  kind,
  value,
}: {
  kind: ReviewListDisplayField["kind"];
  value: string;
}) {
  if (kind === "markdown") {
    return <Markdown className="text-sm text-text">{value}</Markdown>;
  }
  if (kind === "badge") {
    return (
      <span className="inline-block max-w-full break-words rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text-2">
        {value}
      </span>
    );
  }
  if (kind === "link") {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="block min-w-0 truncate text-sm text-orange underline hover:text-orange/80"
      >
        {value}
      </a>
    );
  }
  return <span className="block break-words text-sm text-text">{value}</span>;
}

function ReviewListBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "reviewList" }>;
  onRespond?: (response: UIResponse) => void | Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const row of block.rows) {
      initial[row.id] = (row.defaultDecision ?? "approved") === "approved";
    }
    return initial;
  });
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approvedCount = block.rows.filter(
    (row) => decisions[row.id] === true,
  ).length;

  if (submitted) {
    return (
      <p className="text-xs italic text-text-3">
        Approved {approvedCount} of {block.rows.length}.
      </p>
    );
  }

  const approvedKey = block.approvedKey ?? "approvedPieces";
  const min = Math.max(block.min ?? 0, 0);
  // Clamp the effective max so a caller passing max < min (or a negative) can
  // never wedge submit permanently disabled: the ceiling is at least `min` and
  // never below the row count's natural cap.
  const max = Math.max(min, block.max ?? block.rows.length);
  const inRange = approvedCount >= min && approvedCount <= max;
  const rangeHint = rangeHintFor(approvedCount, min, max);

  async function submit() {
    if (pending) return;
    const approvedPayloads = block.rows
      .filter((row) => decisions[row.id] === true)
      .map((row) => row.payload);
    const decisionList = block.rows.map((row) =>
      decisionEntry(row.payload, decisions[row.id] === true),
    );
    setError(null);
    setPending(true);
    try {
      await onRespond?.({
        blockKind: "reviewList",
        value: `${approvedCount} of ${block.rows.length} approved`,
        ...(block.signalName !== undefined
          ? { signalName: block.signalName }
          : {}),
        payload: { [approvedKey]: approvedPayloads, decisions: decisionList },
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(submitErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Surface className="space-y-3 px-3 py-3">
      {block.title !== undefined && (
        <h3 className="text-sm font-semibold text-text">{block.title}</h3>
      )}
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      {block.rows.length === 0 && (
        <p className="text-sm italic text-text-3">No records to review.</p>
      )}
      <ul className="space-y-2">
        {block.rows.map((row) => {
          const approved = decisions[row.id] === true;
          return (
            <li
              key={row.id}
              data-testid="review-row"
              data-approved={approved}
              className={cn(
                "space-y-2 rounded-lg border border-border p-2.5",
                !approved && "opacity-60",
              )}
            >
              <dl className="space-y-1">
                {block.displayFields.map((field) => {
                  const raw = row.fields[field.key];
                  if (raw === undefined) return null;
                  return (
                    <div key={field.key} className="flex flex-col gap-0.5">
                      <dt className="text-xs font-medium text-text-3">
                        {field.label}
                      </dt>
                      <dd>
                        <ReviewListCell kind={field.kind} value={String(raw)} />
                      </dd>
                    </div>
                  );
                })}
              </dl>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={approved}
                  onClick={() =>
                    setDecisions((prev) => ({ ...prev, [row.id]: true }))
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    approved
                      ? "border-green bg-green/10 text-green"
                      : "border-border text-text-2 hover:border-green hover:text-green",
                  )}
                >
                  Approve
                </button>
                <button
                  type="button"
                  aria-pressed={!approved}
                  onClick={() =>
                    setDecisions((prev) => ({ ...prev, [row.id]: false }))
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    !approved
                      ? "border-red bg-red/10 text-red"
                      : "border-border text-text-2 hover:border-red hover:text-red",
                  )}
                >
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error !== null && <SubmitError message={error} />}
      {rangeHint !== null && <p className="text-xs text-text-3">{rangeHint}</p>}
      <button
        type="button"
        disabled={!inRange || pending}
        onClick={() => {
          void submit();
        }}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text transition-transform hover:border-orange hover:text-orange active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
      >
        {pending && <Spinner />}
        {pending
          ? "Submitting…"
          : (block.submitLabel ?? `Submit ${approvedCount} approved`)}
      </button>
    </Surface>
  );
}

function ChoiceBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "choice" }>;
  onRespond?: (response: UIResponse) => void | Promise<void>;
}) {
  const [answered, setAnswered] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (answered !== null) {
    return <p className="text-xs italic text-text-3">You chose: {answered}</p>;
  }
  // Fold the prompt-box free text into the option's structured payload under the
  // block's `payloadKey` (CL-2683), so a choice carries a rationale the panel
  // equivalent collects. Only merges into an object payload with a non-empty note.
  function resolvePayload(payload: unknown): unknown {
    const note = promptText.trim();
    if (block.promptBox === undefined || note.length === 0) return payload;
    if (typeof payload !== "object" || payload === null) return payload;
    return {
      ...(payload as Record<string, unknown>),
      [block.promptBox.payloadKey]: note,
    };
  }
  // A `required` prompt-box makes the note mandatory: every option's submit is
  // held until the note is non-empty (trim), mirroring the run-page panel's
  // `feedback.trim().length > 0` guard (CL-2730). A non-required box (the
  // default — e.g. ab-compare's optional rationale) never gates submission.
  const noteRequiredMissing =
    block.promptBox?.required === true && promptText.trim().length === 0;
  async function choose(option: (typeof block.options)[number]) {
    if (pendingId !== null) return;
    const payload = resolvePayload(option.payload);
    setError(null);
    setPendingId(option.id);
    try {
      const rawValue = option.value ?? option.label;
      const value =
        typeof rawValue === "string" ||
        typeof rawValue === "number" ||
        typeof rawValue === "boolean"
          ? rawValue
          : JSON.stringify(rawValue);
      await onRespond?.({
        blockKind: "choice",
        value,
        ...(block.signalName !== undefined
          ? { signalName: block.signalName }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
      });
      // Only lock the choice once the host confirms it landed — a failed resume
      // keeps the buttons live so the user can retry (CL-2684).
      setAnswered(option.label);
    } catch (err: unknown) {
      setError(submitErrorMessage(err));
    } finally {
      setPendingId(null);
    }
  }
  return (
    <div className="space-y-2">
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      {block.promptBox !== undefined && (
        <AutoGrowTextarea
          value={promptText}
          onChange={setPromptText}
          placeholder={block.promptBox.placeholder}
          minRows={2}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
        />
      )}
      {error !== null && <SubmitError message={error} />}
      {block.options.some(
        (option) =>
          option.description !== undefined &&
          option.description.trim().length > 0,
      ) ? (
        <div
          className="grid gap-2 sm:grid-cols-2"
          data-testid="choice-card-grid"
        >
          {block.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={noteRequiredMissing || pendingId !== null}
              onClick={() => {
                void choose(option);
              }}
              className="rounded-lg border border-border bg-bg px-3 py-2.5 text-left transition-transform hover:border-orange active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-2 text-sm font-medium text-text">
                {pendingId === option.id && <Spinner />}
                {pendingId === option.id ? "Submitting…" : option.label}
              </span>
              {option.description !== undefined && (
                <span className="mt-0.5 block text-xs text-text-3">
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {block.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={noteRequiredMissing || pendingId !== null}
              onClick={() => {
                void choose(option);
              }}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text transition-transform hover:border-orange hover:text-orange active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
            >
              {pendingId === option.id && <Spinner />}
              {pendingId === option.id ? "Submitting…" : option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
