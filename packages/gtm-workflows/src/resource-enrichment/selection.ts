import { type } from 'arktype';
import type { WorkflowArtifactDraft } from '@workbench/workflow-core';

/** The intake artifact: a structured snapshot of the parsed resource rows. */
export const PARSED_RESOURCE_ARTIFACT_KIND = 'parsed-resource';

/** The per-row HITL artifact: one set of generated option variants to choose from. */
export const SELECTION_ARTIFACT_KIND = 'selection';

/** The terminal download artifact assembled from chosen selections. */
export const CSV_EXPORT_ARTIFACT_KIND = 'csv-export';

// A selection artifact is fully described by its JSON content: a label, one set
// of option strings per field, and the reviewer's chosen index per field (null
// until a human picks). The renderer is driven entirely by this shape — it holds
// no SEO-specific knowledge.
export const selectionArtifactContentSchema = type({
  label: 'string',
  fields: { '[string]': 'string[]' },
  chosen: type({ '[string]': 'number' }).or('null'),
});

export type SelectionArtifactContent = typeof selectionArtifactContentSchema.infer;

function assertValid(value: unknown): SelectionArtifactContent {
  const result = selectionArtifactContentSchema(value);
  if (result instanceof type.errors) {
    throw new Error(`invalid selection artifact content: ${result.summary}`);
  }
  return result;
}

export function buildSelectionArtifactContent(content: SelectionArtifactContent): string {
  return JSON.stringify(assertValid(content));
}

export function parseSelectionArtifactContent(raw: string): SelectionArtifactContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('selection artifact content is not valid JSON');
  }
  return assertValid(parsed);
}

export function createSelectionArtifactDraft(input: {
  label: string;
  fields: Record<string, string[]>;
}): WorkflowArtifactDraft {
  return {
    kind: SELECTION_ARTIFACT_KIND,
    title: input.label,
    content: buildSelectionArtifactContent({
      label: input.label,
      fields: input.fields,
      chosen: null,
    }),
    status: 'draft',
  };
}

// Validate a reviewer's picks against the selection's own fields before writing
// them back: every field must exist and every index must be in range. Fails
// loudly rather than persisting a pick that points at no option.
export function setSelectionChosen(raw: string, chosen: Record<string, number>): string {
  const content = parseSelectionArtifactContent(raw);
  for (const [field, index] of Object.entries(chosen)) {
    const options = content.fields[field];
    if (!options) {
      throw new Error(`unknown selection field: ${field}`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= options.length) {
      throw new Error(`chosen index out of range for field ${field}: ${index}`);
    }
  }
  return buildSelectionArtifactContent({ ...content, chosen });
}

export function selectionHasChosen(raw: string): boolean {
  return parseSelectionArtifactContent(raw).chosen !== null;
}
