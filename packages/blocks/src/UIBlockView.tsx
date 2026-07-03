import { useState } from "react";
import { cn, Markdown } from "@workbench/ui";
import type {
  FormField,
  ProgressStepState,
  UIBlock,
  UIResponse,
} from "./ui-block";

/**
 * The generative-UI registry: the single switch that turns a typed UIBlock into
 * a rendered component. Adding a block type = one variant in the union + one
 * case here. Interactive blocks (choice) call `onRespond`, which the host wires
 * to "send a new user turn", closing the agent loop.
 */
export interface UIBlockViewProps {
  block: UIBlock;
  /** Invoked when an interactive block produces a response to send to the agent. */
  onRespond?: ((response: UIResponse) => void) | undefined;
  /** Invoked for document actions (copy / download / save-artifact). */
  onAction?:
    | ((action: "copy" | "download" | "save-artifact", block: UIBlock) => void)
    | undefined;
}

export function UIBlockView({ block, onRespond, onAction }: UIBlockViewProps) {
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
                    {cell}
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

const STEP_STATE_LABEL: Record<ProgressStepState, string> = {
  done: "done",
  running: "running",
  awaiting: "awaiting input",
  pending: "pending",
  failed: "failed",
};

function StepIndicator({
  state,
  index,
}: {
  state: ProgressStepState;
  index: number;
}) {
  const base =
    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold";
  if (state === "done") {
    return <span className={cn(base, "bg-green text-white")}>✓</span>;
  }
  if (state === "failed") {
    return <span className={cn(base, "bg-red text-white")}>!</span>;
  }
  if (state === "running") {
    return (
      <span className={cn(base, "border-2 border-border")} aria-hidden>
        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-border border-t-blue motion-reduce:animate-none" />
      </span>
    );
  }
  if (state === "awaiting") {
    // Passive status, not a CTA: awaiting steps use the neutral Summit Blue
    // status token, never the orange ACTION token (CL-2683). The choice BUTTON
    // stays orange — that is the actionable affordance.
    return (
      <span className={cn(base, "border-2 border-blue text-blue")}>
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
  return (
    <Surface className="px-3 py-2.5">
      {block.title !== undefined && (
        <div className="pb-2 text-sm font-medium text-text-2">
          {block.title}
        </div>
      )}
      <ol className="space-y-2" aria-live="polite">
        {block.steps.map((step, index) => {
          const state = effectiveStepState(block.steps, index);
          return (
            <li
              key={index}
              data-state={state}
              className={cn(
                "flex items-center gap-2.5",
                state === "pending" && "opacity-50",
              )}
            >
              <StepIndicator state={state} index={index} />
              <span className="min-w-0 flex-1">
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
              </span>
              <span className="shrink-0 text-xs text-text-3">
                {STEP_STATE_LABEL[state]}
              </span>
            </li>
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
  if (field.kind === "multiSelect") return [];
  if (field.kind === "number") {
    return field.defaultValue === undefined ? "" : String(field.defaultValue);
  }
  return field.defaultValue ?? "";
}

function initialValue(field: FormField): FieldValue {
  if (field.kind === "group") {
    const rowCount = Math.max(field.min ?? 1, 1);
    return Array.from({ length: rowCount }, () => emptyRow(field.fields));
  }
  return leafInitialValue(field);
}

function emptyRow(fields: LeafField[]): Record<string, LeafValue> {
  const row: Record<string, LeafValue> = {};
  for (const field of fields) row[field.name] = leafInitialValue(field);
  return row;
}

function leafFilled(field: LeafField, value: LeafValue): boolean {
  if (field.required !== true) return true;
  if (field.kind === "multiSelect") {
    return Array.isArray(value) && value.length >= Math.max(field.min ?? 1, 1);
  }
  return typeof value === "string" && value.trim().length > 0;
}

function fieldSatisfied(field: FormField, value: FieldValue): boolean {
  if (field.kind !== "group") return leafFilled(field, value as LeafValue);
  const rows = value as Record<string, LeafValue>[];
  if (rows.length < Math.max(field.min ?? 0, 0)) return false;
  return rows.every((row) =>
    field.fields.every((sub) => leafFilled(sub, row[sub.name] ?? "")),
  );
}

function leafToPayload(field: LeafField, value: LeafValue): unknown {
  if (field.kind === "multiSelect") return value;
  if (field.kind === "number") {
    const text = value as string;
    return text.trim().length === 0 ? undefined : Number(text);
  }
  return value;
}

function fieldToPayload(field: FormField, value: FieldValue): unknown {
  if (field.kind !== "group") return leafToPayload(field, value as LeafValue);
  const rows = value as Record<string, LeafValue>[];
  return rows.map((row) => {
    const entry: Record<string, unknown> = {};
    for (const sub of field.fields) {
      const converted = leafToPayload(sub, row[sub.name] ?? "");
      if (converted !== undefined) entry[sub.name] = converted;
    }
    return entry;
  });
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
        <textarea
          value={value as string}
          placeholder={field.placeholder}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
          className={cn(inputClass, "resize-none")}
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
  onRespond?: (response: UIResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {};
    for (const field of block.fields) initial[field.name] = initialValue(field);
    return initial;
  });
  const [submitted, setSubmitted] = useState(false);

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

  function submit() {
    const payload: Record<string, unknown> = {};
    for (const field of block.fields) {
      const converted = fieldToPayload(
        field,
        values[field.name] ?? initialValue(field),
      );
      if (converted !== undefined) payload[field.name] = converted;
    }
    setSubmitted(true);
    onRespond?.({
      blockKind: "form",
      value: "",
      ...(block.signalName !== undefined
        ? { signalName: block.signalName }
        : {}),
      payload,
    });
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
        const atMin = rows.length <= Math.max(field.min ?? 1, 1);
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
      <button
        type="button"
        disabled={!complete}
        onClick={submit}
        className="rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text hover:border-orange hover:text-orange disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
      >
        {block.submitLabel ?? "Submit"}
      </button>
    </Surface>
  );
}

function MultiSelectBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "multiSelect" }>;
  onRespond?: (response: UIResponse) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

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
      <button
        type="button"
        disabled={!inRange}
        onClick={() => {
          setSubmitted(true);
          onRespond?.({
            blockKind: "multiSelect",
            value: selected.join(", "),
            ...(block.signalName !== undefined
              ? { signalName: block.signalName }
              : {}),
            payload: selected,
          });
        }}
        className="rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text hover:border-orange hover:text-orange disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
      >
        {block.submitLabel ?? "Submit"}
      </button>
    </div>
  );
}

function ChoiceBlock({
  block,
  onRespond,
}: {
  block: Extract<UIBlock, { kind: "choice" }>;
  onRespond?: (response: UIResponse) => void;
}) {
  const [answered, setAnswered] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
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
  return (
    <div className="space-y-2">
      {block.prompt !== undefined && (
        <p className="text-sm text-text-2">{block.prompt}</p>
      )}
      {block.promptBox !== undefined && (
        <textarea
          value={promptText}
          onChange={(event) => setPromptText(event.target.value)}
          placeholder={block.promptBox.placeholder}
          rows={2}
          className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
        />
      )}
      <div className="flex flex-wrap gap-2">
        {block.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={noteRequiredMissing}
            onClick={() => {
              setAnswered(option.label);
              const payload = resolvePayload(option.payload);
              onRespond?.({
                blockKind: "choice",
                value: option.value ?? option.label,
                ...(block.signalName !== undefined
                  ? { signalName: block.signalName }
                  : {}),
                ...(payload !== undefined ? { payload } : {}),
              });
            }}
            className="rounded-full border border-border bg-bg px-3 py-1.5 text-sm text-text hover:border-orange hover:text-orange disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:text-text"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
