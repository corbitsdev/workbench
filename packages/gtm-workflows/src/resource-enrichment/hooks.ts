import type { WorkflowStepState, WorkflowStepStateContext } from '@workbench/workflow-core';
import {
  CSV_EXPORT_ARTIFACT_KIND,
  PARSED_RESOURCE_ARTIFACT_KIND,
  SELECTION_ARTIFACT_KIND,
  selectionHasChosen,
} from './selection';

export function deriveResourceEnrichmentRunTitle(
  input: Record<string, unknown> | undefined
): string | null {
  const filename = input?.['filename'];
  if (typeof filename === 'string' && filename.length > 0) {
    return filename;
  }
  return null;
}

export function deriveResourceEnrichmentCurrentStep(status: string): string {
  switch (status) {
    case 'pending':
      return 'intake';
    case 'running':
    case 'generating':
      return 'enrich';
    case 'reviewing':
      return 'review';
    case 'done':
      return 'export';
    case 'failed':
      return 'intake';
    default:
      throw new Error(`Unknown workflow status: ${status}`);
  }
}

export function serializeResourceEnrichmentStepState(
  context: WorkflowStepStateContext
): Record<string, WorkflowStepState> {
  const parsed = context.artifacts.filter((a) => a.kind === PARSED_RESOURCE_ARTIFACT_KIND);
  const selections = context.artifacts.filter((a) => a.kind === SELECTION_ARTIFACT_KIND);
  const csvExports = context.artifacts.filter((a) => a.kind === CSV_EXPORT_ARTIFACT_KIND);

  const everySelectionChosen =
    selections.length > 0 &&
    selections.every((a) => {
      const content = a['content'];
      return typeof content === 'string' && selectionHasChosen(content);
    });

  return {
    intake: { completed: parsed.length > 0, rows: parsed.length },
    enrich: { completed: selections.length > 0, selections },
    review: { completed: everySelectionChosen },
    export: { completed: csvExports.length > 0, artifacts: csvExports },
  };
}

// The enrich step always produces selection artifacts; resource enrichment has
// no user-facing output-kind menu, so the requested set is ignored.
export function selectResourceEnrichmentArtifactKinds(): string[] {
  return [SELECTION_ARTIFACT_KIND];
}
