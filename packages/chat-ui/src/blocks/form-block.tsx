import type { FormBlockData } from "@corbits/chat/blocks";

import { CHAT_STRINGS } from "../strings";
import { BlockCard } from "./block-card";

function FieldControl({
  fieldId,
  field,
}: {
  readonly fieldId: string;
  readonly field: FormBlockData["fields"][number];
}) {
  if (field.input === "textarea") {
    return (
      <textarea id={fieldId} defaultValue={field.value} disabled rows={3} />
    );
  }
  if (field.input === "select") {
    return (
      <select id={fieldId} defaultValue={field.value} disabled>
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
        defaultChecked={field.value === "true"}
        disabled
      />
    );
  }
  return <input id={fieldId} type="text" defaultValue={field.value} disabled />;
}

export function FormBlockView({ data }: { readonly data: FormBlockData }) {
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
            <FieldControl fieldId={fieldId} field={field} />
          </div>
        );
      })}
      <div className="chat-block-actions">
        <button
          type="button"
          className="chat-block-action"
          data-primary="true"
          disabled
        >
          {data.submitLabel ?? CHAT_STRINGS.blockFormSubmit}
        </button>
      </div>
    </BlockCard>
  );
}
