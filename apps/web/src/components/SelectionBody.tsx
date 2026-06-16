import { useState } from 'react';
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

// Validate the artifact content at the boundary; a malformed selection renders a
// notice rather than throwing and blanking the panel.
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
  const [error, setError] = useState<string | null>(null);

  if (!parsed) {
    return <p className="text-sm text-text-3 p-4">Selection content is unavailable.</p>;
  }

  const fieldNames = Object.keys(parsed.fields);
  const readOnly = parsed.chosen !== null;
  const allChosen = fieldNames.every((field) => selected[field] !== undefined);

  const handleSubmit = () => {
    setError(null);
    updateSelection.mutate(
      { artifactId, chosen: selected },
      { onError: () => setError('Could not save your selection. Please try again.') }
    );
  };

  return (
    <div className="space-y-5">
      <h3 className="text-base font-semibold text-text">{parsed.label}</h3>
      {fieldNames.map((field) => (
        <fieldset key={field} className="space-y-2">
          <legend className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-1">
            {field}
          </legend>
          {parsed.fields[field].map((option, index) => (
            <label
              key={index}
              className="flex items-start gap-2 text-sm text-text-2 cursor-pointer"
            >
              <input
                type="radio"
                name={`${artifactId}:${field}`}
                value={`${field}:${index}`}
                checked={selected[field] === index}
                disabled={readOnly}
                onChange={() => setSelected((prev) => ({ ...prev, [field]: index }))}
                className="mt-1"
              />
              <span>{option}</span>
            </label>
          ))}
        </fieldset>
      ))}
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
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
