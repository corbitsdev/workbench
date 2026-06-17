import { useState } from 'react';
import { selectionHasChosen } from '@workbench/gtm-workflows';
import { ResourceEnrichmentWorkflowPanel } from '@workbench/workflow';
import {
  useRunResourceEnrichmentStep,
  useWorkflow,
  type FrontendWorkflowState,
} from '../../hooks/use-workflow';
import SelectionBody from '../../components/SelectionBody';
import type { WorkflowSelectedPanelProps } from '../registry';

function resourceTitle(workflow: FrontendWorkflowState | undefined): string | undefined {
  const intake = workflow?.steps?.intake as { rows?: number } | undefined;
  if (typeof intake?.rows === 'number') {
    return `Catalog (${intake.rows} row${intake.rows === 1 ? '' : 's'})`;
  }
  return workflow?.companyName ?? undefined;
}

function selectionArtifacts(
  workflow: FrontendWorkflowState | undefined
): Array<{ id: string; title: string; content: string; kind: string }> {
  const enrich = workflow?.steps?.enrich as
    | { selections?: Array<{ id: string; title: string; content: string; kind: string }> }
    | undefined;
  return enrich?.selections ?? [];
}

export function SeoEnrichmentSelectedPanel({ workflowId, onClose }: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const runStep = useRunResourceEnrichmentStep(workflowId);
  const [stepError, setStepError] = useState<string | null>(null);

  const selections = selectionArtifacts(workflow);
  const canExport = selections.some((artifact) => selectionHasChosen(artifact.content));

  const runEnrichmentStep = (step: 'enrich' | 'export') => {
    setStepError(null);
    runStep.mutateAsync(step).catch((err) => {
      setStepError(err instanceof Error ? err.message : 'Step failed');
    });
  };

  return (
    <ResourceEnrichmentWorkflowPanel
      workflow={workflow}
      isLoading={isLoading}
      isError={isError}
      title={resourceTitle(workflow) ?? 'SEO Enrichment'}
      onClose={onClose}
      onEnrich={() => runEnrichmentStep('enrich')}
      onExport={() => runEnrichmentStep('export')}
      canExport={canExport}
      stepError={stepError}
      isEnrichPending={runStep.isPending && workflow?.status === 'ready'}
      isExportPending={runStep.isPending && workflow?.status === 'reviewing'}
      renderSelection={(artifact) => (
        <SelectionBody
          content={artifact.content}
          workflowId={workflowId}
          artifactId={artifact.id}
        />
      )}
      renderCsvDownload={(artifact) => (
        <a
          href={`/api/v1/artifacts/${artifact.id}/download`}
          className="btn-primary w-full text-center block"
        >
          Download CSV
        </a>
      )}
    />
  );
}