import {
  scheduleFieldInputHint,
  sortScheduleFields,
  type ScheduleFieldMetadata,
} from "@workbench/shared";

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
        const str =
          raw === undefined || raw === null
            ? ""
            : typeof raw === "string"
              ? raw
              : String(raw);
        const boolVal = raw === true || raw === "true";

        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label
              htmlFor={fieldId}
              className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.05em] text-text-3"
            >
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
            </label>
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
                        .filter((item): item is string => typeof item === "string")
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
    const v = values[field.name];
    if (v === undefined || v === null) return false;
    if (typeof v === "string" && v.trim() === "") return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === "boolean") continue;

  }
  return true;
}
