import { cn } from "@workbench/ui";
import {
  type SettingsChangeHandler,
  type SettingsField,
  type SettingsSectionDescriptor,
  type SettingsValues,
} from "./types";
import { Select, TextInput, Toggle } from "./primitives";

interface SettingsFieldRowProps {
  readonly field: SettingsField;
  readonly values: SettingsValues;
  readonly onChange: SettingsChangeHandler;
}

function SettingsFieldRow({ field, values, onChange }: SettingsFieldRowProps) {
  const raw = values[field.key];
  const controlId = `settings-field-${field.key}`;

  return (
    <div className="flex flex-col gap-1.5 py-3 border-b border-border last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={controlId} className="text-sm font-medium text-text">
          {field.label}
        </label>
        {field.kind === "toggle" && (
          <Toggle
            id={controlId}
            aria-label={field.label}
            checked={raw === true}
            disabled={field.disabled ?? false}
            onCheckedChange={(checked) => onChange(field.key, checked)}
          />
        )}
      </div>

      {field.kind === "text" && (
        <TextInput
          id={controlId}
          value={typeof raw === "string" ? raw : ""}
          placeholder={field.placeholder ?? ""}
          disabled={field.disabled ?? false}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      )}

      {field.kind === "select" && (
        <Select
          id={controlId}
          value={typeof raw === "string" ? raw : ""}
          disabled={field.disabled ?? false}
          onChange={(event) => onChange(field.key, event.target.value)}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}

      {field.description !== undefined && (
        <p className="text-xs text-text-3">{field.description}</p>
      )}
    </div>
  );
}

export interface SettingsSectionProps {
  readonly section: SettingsSectionDescriptor;
  readonly values: SettingsValues;
  readonly onChange: SettingsChangeHandler;
  readonly className?: string;
}

export function SettingsSection({
  section,
  values,
  onChange,
  className,
}: SettingsSectionProps) {
  return (
    <section
      aria-labelledby={`settings-section-${section.id}`}
      className={cn(
        "rounded-xl border border-border bg-surface p-5",
        className,
      )}
    >
      <header className="mb-2">
        <h2
          id={`settings-section-${section.id}`}
          className="text-base font-semibold text-text"
        >
          {section.title}
        </h2>
        {section.description !== undefined && (
          <p className="mt-1 text-sm text-text-2">{section.description}</p>
        )}
      </header>
      <div>
        {section.fields.map((field) => (
          <SettingsFieldRow
            key={field.key}
            field={field}
            values={values}
            onChange={onChange}
          />
        ))}
      </div>
    </section>
  );
}
