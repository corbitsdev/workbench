import { PresentationWorkflowPanel } from '@workbench/workflow';
import { useWorkflow } from '../../hooks/use-workflow';
import type { WorkflowSelectedPanelProps } from '../registry';

export function PresentationSelectedPanel({ workflowId, onClose }: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);

  const generateStep = workflow?.steps.generate as { gammaUrl?: unknown } | undefined;
  const gammaUrl = typeof generateStep?.gammaUrl === 'string' ? generateStep.gammaUrl : undefined;

  return (
    <PresentationWorkflowPanel
      workflow={workflow}
      isLoading={isLoading}
      isError={isError}
      gammaUrl={gammaUrl}
      onClose={onClose}
    />
  );
}
