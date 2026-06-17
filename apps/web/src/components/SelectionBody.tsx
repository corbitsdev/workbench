import { useMemo, useState } from 'react';
import { type } from 'arktype';
import {
  selectionArtifactContentSchema,
  type SelectionArtifactContent,
} from '@workbench/gtm-workflows';
import { useUpdateSelection } from '../hooks/use-workflow';

interface SelectionBodyProps {
  content: string;
  workflowId: string;
  artifactId: string;
}

function parseSelectionContent(raw: string): SelectionArtifactContent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = selectionArtifactContentSchema(json);
  if (result instanceof type.errors) return null;
  return result;
}

export default function SelectionBody({ content, workflowId, artifactId }: SelectionBodyProps) {
  const parsed = parseSelectionContent(content);
  const updateSelection = useUpdateSelection(workflowId);
  const [selected, setSelected] = useState<Record<string, number>>(parsed?.chosen ?? {});
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fieldNames = useMemo(() => (parsed ? Object.keys(parsed.fields) : []), [parsed]);

  if (!parsed) {
    return <p className="text-sm text-text-3 p-4">Selection content is unavailable.</p>;
  }

  const fieldName = fieldNames[activeIndex] ?? fieldNames[0];
  const options = fieldName ? parsed.fields[fieldName] : [];
  const readOnly = parsed.chosen !== null;
  const allChosen = fieldNames.every((field) => selected[field] !== undefined);
  const selectedOptionIndex = fieldName ? selected[fieldName] : undefined;

  const handleSubmit = () => {
    setError(null);
    updateSelection.mutate(
      { artifactId, chosen: selected },
      { onError: () => setError('Could not save your selection. Please try again.') }
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text">{parsed.label}</h3>
          <p className="text-xs text-text-3">
            Section {activeIndex + 1} of {fieldNames.length}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setActiveIndex((prev) => Math.max(0, prev - 1))}
            disabled={activeIndex === 0}
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-2 disabled:opacity-50"
          >
            Previous section
          </button>
          <button
            type="button"
            onClick={() => setActiveIndex((prev) => Math.min(fieldNames.length - 1, prev + 1))}
            disabled={activeIndex >= fieldNames.length - 1}
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-2 disabled:opacity-50"
          >
            Next section
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
          {parsed.imageLink ? (
            <img
              src={parsed.imageLink}
              alt={parsed.label}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid min-h-[280px] place-items-center p-6 text-center text-sm text-text-3">
              Image unavailable.
            </div>
          )}
        </div>

        <fieldset className="space-y-3 rounded-[10px] border border-border bg-surface p-4">
          <legend className="text-xs font-semibold uppercase tracking-wide text-text-3">
            {fieldName}
          </legend>
          <div className="space-y-2">
            {options.map((option, index) => (
              <label
                key={index}
                className="flex cursor-pointer items-start gap-2 rounded-[8px] border border-transparent p-2 text-sm text-text-2 hover:border-border hover:bg-surface-2"
              >
                <input
                  type="radio"
                  name={`${artifactId}:${fieldName}`}
                  value={`${fieldName}:${index}`}
                  checked={selectedOptionIndex === index}
                  disabled={readOnly}
                  onChange={() => setSelected((prev) => ({ ...prev, [fieldName]: index }))}
                  className="mt-1"
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {fieldNames.map((field, index) => (
            <button
              key={field}
              type="button"
              onClick={() => setActiveIndex(index)}
              aria-pressed={index === activeIndex}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                index === activeIndex
                  ? 'bg-accent text-white'
                  : 'bg-surface-2 text-text-2 hover:text-text'
              }`}
            >
              {field}
            </button>
          ))}
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allChosen || updateSelection.isPending}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {updateSelection.isPending ? 'Saving…' : 'Save selection'}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
