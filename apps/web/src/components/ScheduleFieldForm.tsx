import { type } from "arktype";
import {
  scheduleFieldInputHint,
  sortScheduleFields,
  SelectedPersonListSchema,
  type ScheduleFieldMetadata,
  type SelectedPerson,
} from "@workbench/shared";
import { useActiveWorkbench } from "../lib/active-workbench-context";
import { useMembers, type Member } from "../hooks/use-members";
import { useScheduleFieldOptions } from "../hooks/use-schedule-field-options";

/**
 * Select control for a field whose options come from a live source
 * (CL-4279) rather than being declared statically. A separate component so
 * `useScheduleFieldOptions` is called unconditionally per option-backed
 * field, not inside the parent's field-list loop. Renders the option label
 * but submits the underlying id; on fetch failure it says so explicitly
 * instead of falling back to free text or an empty select — either of those
 * would reintroduce the unanswerable-list-id bug this mechanism fixes.
 */
function ScheduleFieldOptionsSelect({
  field,
  fieldId,
  value,
  disabled,
  onChange,
}: {
  field: ScheduleFieldMetadata;
  fieldId: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const query = useScheduleFieldOptions(field.optionsSource);

  if (query.isPending) {
    return (
      <p
        className="text-xs text-text-3"
        data-testid={`field-options-loading-${field.name}`}
      >
        Loading options…
      </p>
    );
  }

  if (query.isError) {
    return (
      <p
        className="text-xs text-red-500"
        data-testid={`field-options-error-${field.name}`}
        role="alert"
      >
        Could not load options: {query.error.message}
      </p>
    );
  }

  return (
    <select
      id={fieldId}
      name={field.name}
      value={value}
      required={field.required}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
    >
      <option value="">Select…</option>
      {query.data.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function asSelectedPeople(raw: unknown): SelectedPerson[] {
  const parsed = SelectedPersonListSchema(raw);
  if (parsed instanceof type.errors) return [];
  return parsed;
}

/**
 * People picker for `select-multi` (CL-4429). Options come from the existing
 * membership-gated `GET /members`; the selection is stored as
 * `{ refId, displayName }` pairs so the run reads people straight off the
 * trigger payload with no run-time roster resolution. An empty selection is
 * empty — it never means "everyone".
 */
function ScheduleFieldPeoplePicker({
  field,
  labelledBy,
  selected,
  disabled,
  onChange,
}: {
  field: ScheduleFieldMetadata;
  labelledBy: string;
  selected: SelectedPerson[];
  disabled: boolean;
  onChange: (next: SelectedPerson[]) => void;
}) {
  const { activeTenantId } = useActiveWorkbench();
  const query = useMembers(activeTenantId);

  if (query.isPending) {
    return (
      <p
        className="text-xs text-text-3"
        data-testid={`field-options-loading-${field.name}`}
      >
        Loading people…
      </p>
    );
  }

  if (query.isError) {
    return (
      <p
        className="text-xs text-red-500"
        data-testid={`field-options-error-${field.name}`}
        role="alert"
      >
        Could not load people: {query.error.message}
      </p>
    );
  }

  const selectedRefIds = new Set(selected.map((person) => person.refId));
  const toggle = (member: Member) => {
    if (selectedRefIds.has(member.refId)) {
      onChange(selected.filter((person) => person.refId !== member.refId));
      return;
    }
    onChange([...selected, { refId: member.refId, displayName: member.name }]);
  };

  if (query.data.length === 0) {
    return (
      <p
        className="text-xs text-text-3"
        data-testid={`field-select-multi-empty-${field.name}`}
      >
        No people in this workbench yet.
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      data-testid={`field-select-multi-${field.name}`}
      className="flex flex-col gap-1.5 rounded-[10px] border border-border bg-page px-3 py-2"
    >
      {query.data.map((member) => (
        <label
          key={member.refId}
          className="inline-flex items-center gap-2 text-sm text-text"
        >
          <input
            type="checkbox"
            name={`${field.name}[]`}
            value={member.refId}
            checked={selectedRefIds.has(member.refId)}
            disabled={disabled}
            onChange={() => toggle(member)}
            className="accent-accent"
          />
          <span>{member.name}</span>
        </label>
      ))}
    </div>
  );
}

export type ScheduleFieldFormProps = {
  fields: readonly ScheduleFieldMetadata[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  idPrefix?: string;
};

/**
 * Schema-driven schedule intake form (CL-3861). Renders create/edit UI from
 * field list + metadata — no per-kind bespoke forms. Profile-sourced fields
 * are read-only with a chip; other fields use inputHint for control type.
 */
export function ScheduleFieldForm({
  fields,
  values,
  onChange,
  disabled = false,
  idPrefix = "sched-field",
}: ScheduleFieldFormProps) {
  const ordered = sortScheduleFields(fields);

  if (ordered.length === 0) {
    return (
      <p
        className="text-xs text-text-3"
        data-testid="schedule-field-form-empty"
      >
        No intake fields — this workflow runs with defaults.
      </p>
    );
  }

  const setValue = (name: string, value: unknown) => {
    onChange({ ...values, [name]: value });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="schedule-field-form">
      {ordered.map((field) => {
        const hint = scheduleFieldInputHint(field);
        const fromProfile = Boolean(field.fromProfile);
        const fieldId = `${idPrefix}-${field.name}`;
        const raw = values[field.name];
        // A field's `defaultValue` (CL-4538) renders as a real initial value —
        // not a placeholder — so an untouched field still shows, and later
        // submits, the value the dock's `STEP_UI` form pre-fills.
        const effective =
          raw === undefined || raw === null ? field.defaultValue : raw;
        const str =
          effective === undefined || effective === null
            ? ""
            : typeof effective === "string"
              ? effective
              : String(effective);
        const boolVal = effective === true || effective === "true";
        // A checkbox group is not a labelable element, so it gets an
        // `aria-labelledby` caption instead of a `<label htmlFor>`.
        const isGroup = hint === "select-multi";
        const labelId = `${fieldId}-label`;
        const labelClassName =
          "flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.05em] text-text-3";
        const labelContent = (
          <>
            <span>
              {field.label}
              {field.required ? (
                <span className="text-orange" aria-hidden>
                  {" "}
                  *
                </span>
              ) : null}
            </span>
            {fromProfile ? (
              <span
                className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-text-2"
                data-testid={`from-profile-chip-${field.name}`}
              >
                from your profile
              </span>
            ) : null}
          </>
        );

        return (
          <div key={field.name} className="flex flex-col gap-1">
            {isGroup ? (
              <span id={labelId} className={labelClassName}>
                {labelContent}
              </span>
            ) : (
              <label htmlFor={fieldId} className={labelClassName}>
                {labelContent}
              </label>
            )}
            {field.help ? (
              <p className="text-xs text-text-3">{field.help}</p>
            ) : null}
            {hint === "textarea" ? (
              <textarea
                id={fieldId}
                name={field.name}
                value={str}
                placeholder={field.placeholder}
                required={field.required}
                disabled={disabled || fromProfile}
                readOnly={fromProfile}
                rows={3}
                onChange={(e) => setValue(field.name, e.target.value)}
                className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
              />
            ) : hint === "string-array" ? (
              <textarea
                id={fieldId}
                name={field.name}
                value={
                  Array.isArray(raw)
                    ? raw
                        .filter(
                          (item): item is string => typeof item === "string",
                        )
                        .join("\n")
                    : str
                }
                placeholder={field.placeholder ?? "One value per line"}
                required={field.required}
                disabled={disabled || fromProfile}
                readOnly={fromProfile}
                rows={3}
                onChange={(e) =>
                  setValue(
                    field.name,
                    e.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter((line) => line.length > 0),
                  )
                }
                className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
              />
            ) : hint === "number" ? (
              <input
                id={fieldId}
                name={field.name}
                type="number"
                value={str}
                placeholder={field.placeholder}
                required={field.required}
                min={field.min}
                max={field.max}
                step={field.step}
                disabled={disabled || fromProfile}
                readOnly={fromProfile}
                onChange={(e) => {
                  const next = e.target.value;
                  setValue(field.name, next === "" ? undefined : Number(next));
                }}
                className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
              />
            ) : hint === "boolean" ? (
              <label className="inline-flex items-center gap-2 text-sm text-text">
                <input
                  id={fieldId}
                  name={field.name}
                  type="checkbox"
                  checked={boolVal}
                  disabled={disabled || fromProfile}
                  onChange={(e) => setValue(field.name, e.target.checked)}
                  className="accent-accent"
                />
                <span>{field.placeholder ?? "Enabled"}</span>
              </label>
            ) : hint === "select-multi" ? (
              <ScheduleFieldPeoplePicker
                field={field}
                labelledBy={labelId}
                selected={asSelectedPeople(raw)}
                disabled={disabled || fromProfile}
                onChange={(next) => setValue(field.name, next)}
              />
            ) : hint === "select" && field.optionsSource ? (
              <ScheduleFieldOptionsSelect
                field={field}
                fieldId={fieldId}
                value={str}
                disabled={disabled || fromProfile}
                onChange={(next) => setValue(field.name, next)}
              />
            ) : hint === "select" ? (
              <select
                id={fieldId}
                name={field.name}
                value={str}
                required={field.required}
                disabled={disabled || fromProfile}
                onChange={(e) => setValue(field.name, e.target.value)}
                className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
              >
                <option value="">Select…</option>
                {(field.options ?? []).map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={fieldId}
                name={field.name}
                type={hint === "url" ? "url" : "text"}
                value={str}
                placeholder={field.placeholder}
                required={field.required}
                disabled={disabled || fromProfile}
                readOnly={fromProfile}
                onChange={(e) => setValue(field.name, e.target.value)}
                className="w-full rounded-[10px] border border-border bg-page px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-border-strong disabled:opacity-60"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** True when every required (non-profile) field has a non-empty value. */
export function scheduleFieldsComplete(
  fields: readonly ScheduleFieldMetadata[],
  values: Record<string, unknown>,
): boolean {
  for (const field of fields) {
    if (!field.required || field.fromProfile) continue;
    const raw = values[field.name];
    const v =
      (raw === undefined || raw === null) && field.defaultValue !== undefined
        ? field.defaultValue
        : raw;
    if (v === undefined || v === null) return false;
    if (typeof v === "string" && v.trim() === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "boolean") continue;
  }
  return true;
}
