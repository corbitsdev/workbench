// A form field's submitted value never comes from anything but this
// principal's own round-trip: the "submitted" state and its pre-filled
// values are read back from `BlockResponseActions.getResponses`'s `own`
// after every submit, never assumed from the values still sitting in local
// state. Other principals' submissions are never fetched or shown here at
// all -- the server-side aggregation never puts them on the wire for a
// form block in the first place (see `packages/chat/src/routes.ts`).

import { Button } from "@corbits/react-ui";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { FormBlockData } from "@corbits/chat/blocks";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";
import type {
  BlockResponseActions,
  BlockResponseQuery,
} from "./block-responses";

type FieldValues = Readonly<Record<string, string>>;

function defaultValues(data: FormBlockData): FieldValues {
  const values: Record<string, string> = {};
  for (const field of data.fields) {
    values[field.id] = field.value ?? "";
  }
  return values;
}

function ownValues(query: BlockResponseQuery): FieldValues | null {
  if (query.kind !== "ready" || query.own === null) return null;
  return query.own.kind === "form" ? query.own.values : null;
}

function isBlank(
  field: FormBlockData["fields"][number],
  value: string,
): boolean {
  return field.input === "checkbox" ? value !== "true" : value.trim() === "";
}

function validate(
  data: FormBlockData,
  values: FieldValues,
): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const field of data.fields) {
    if (field.required === true && isBlank(field, values[field.id] ?? "")) {
      errors[field.id] = CHAT_STRINGS.blockFormFieldRequired;
    }
  }
  return errors;
}

function FieldControl({
  fieldId,
  field,
  value,
  disabled,
  onChange,
}: {
  readonly fieldId: string;
  readonly field: FormBlockData["fields"][number];
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  if (field.input === "textarea") {
    return (
      <textarea
        id={fieldId}
        value={value}
        disabled={disabled}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.input === "select") {
    return (
      <select
        id={fieldId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.input === "checkbox") {
    return (
      <input
        id={fieldId}
        type="checkbox"
        checked={value === "true"}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked ? "true" : "false")}
      />
    );
  }
  return (
    <input
      id={fieldId}
      type="text"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function FormBlockView({
  data,
  messageId,
  actions,
}: {
  readonly data: FormBlockData;
  readonly messageId?: string;
  readonly actions?: BlockResponseActions;
}) {
  const [query, setQuery] = useState<BlockResponseQuery>({ kind: "loading" });
  const [values, setValues] = useState<FieldValues>(() => defaultValues(data));
  const [fieldErrors, setFieldErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (actions === undefined || messageId === undefined) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    actions.getResponses(messageId, data.formId).then((result) => {
      if (cancelled) return;
      setQuery(result);
      const stored = ownValues(result);
      if (stored !== null) {
        setValues({ ...defaultValues(data), ...stored });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [actions, messageId, data]);

  if (actions === undefined || messageId === undefined) {
    return (
      <BlockCard title={data.title}>
        {data.fields.map((field) => {
          const fieldId = `${data.formId}-${field.id}`;
          return (
            <div key={field.id} className="chat-block-field">
              <label htmlFor={fieldId}>
                {field.label}
                {field.required === true && (
                  <span className="chat-block-required" aria-hidden="true">
                    {" "}
                    *
                  </span>
                )}
              </label>
              <FieldControl
                fieldId={fieldId}
                field={field}
                value={field.value ?? ""}
                disabled
                onChange={() => undefined}
              />
            </div>
          );
        })}
        <div className="chat-block-actions">
          <Button type="button" variant="primary" disabled>
            {data.submitLabel ?? CHAT_STRINGS.blockFormSubmit}
          </Button>
        </div>
      </BlockCard>
    );
  }

  const submitted = ownValues(query) !== null;
  const locked = submitted && !editing;
  const fieldsDisabled = locked || submitting;

  function handleChange(fieldId: string, value: string) {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    if (fieldErrors[fieldId] !== undefined) {
      setFieldErrors(
        Object.fromEntries(
          Object.entries(fieldErrors).filter(([id]) => id !== fieldId),
        ),
      );
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions === undefined || messageId === undefined) return;
    const errors = validate(data, values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    actions
      .submitForm(messageId, data.formId, values)
      .then((result) => {
        if (result.kind !== "submitted") {
          setSubmitError(CHAT_STRINGS.blockFormSubmitError);
          return;
        }
        setEditing(false);
        return actions.getResponses(messageId, data.formId).then((next) => {
          setQuery(next);
          const stored = ownValues(next);
          if (stored !== null) setValues({ ...defaultValues(data), ...stored });
        });
      })
      .finally(() => setSubmitting(false));
  }

  return (
    <BlockCard title={data.title}>
      <form onSubmit={handleSubmit}>
        {data.fields.map((field) => {
          const fieldId = `${data.formId}-${field.id}`;
          return (
            <div key={field.id} className="chat-block-field">
              <label htmlFor={fieldId}>
                {field.label}
                {field.required === true && (
                  <span className="chat-block-required" aria-hidden="true">
                    {" "}
                    *
                  </span>
                )}
              </label>
              <FieldControl
                fieldId={fieldId}
                field={field}
                value={values[field.id] ?? ""}
                disabled={fieldsDisabled}
                onChange={(value) => handleChange(field.id, value)}
              />
              {fieldErrors[field.id] !== undefined && (
                <p
                  className="chat-block-text chat-block-field-error"
                  role="alert"
                >
                  {fieldErrors[field.id]}
                </p>
              )}
            </div>
          );
        })}
        {submitError !== null && (
          <p className="chat-block-text" role="alert">
            {submitError}
          </p>
        )}
        <div className="chat-block-actions">
          {locked ? (
            <>
              <span
                className="chat-block-form-submitted"
                data-status="submitted"
              >
                {CHAT_STRINGS.blockFormSubmitted}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditing(true)}
              >
                {CHAT_STRINGS.blockFormEdit}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting
                ? CHAT_STRINGS.blockFormSubmitting
                : (data.submitLabel ?? CHAT_STRINGS.blockFormSubmit)}
            </Button>
          )}
        </div>
      </form>
    </BlockCard>
  );
}
