import { PresentationWorkflowPanel } from '@workbench/workflow';
import { useWorkflow } from '../../hooks/use-workflow';
import { useGeraltInstances } from '../../hooks/use-presentation-workflow';
import type { WorkflowSelectedPanelProps } from '../registry';

// Selected-workflow panel for presentation-generation. Reads the run and the
// Geralt instance the brief was dispatched to (recorded on the generate step),
// then renders the package-owned panel.
export function PresentationSelectedPanel({
  workflowId,
  onClose,
  onOpenAgent,
}: WorkflowSelectedPanelProps) {
  const { data: workflow, isLoading, isError } = useWorkflow(workflowId);
  const { data: geraltInstances } = useGeraltInstances();

  const generateStep = workflow?.steps.generate as { agentInstanceId?: unknown } | undefined;
  const dispatchedId =
    typeof generateStep?.agentInstanceId === 'string' ? generateStep.agentInstanceId : undefined;
  const geralt = geraltInstances.find((instance) => instance.id === dispatchedId);

  return (
    <PresentationWorkflowPanel
      workflow={workflow}
      isLoading={isLoading}
      isError={isError}
      geraltInstanceId={geralt ? geralt.id : null}
      onOpenAgent={
        geralt
          ? () =>
              onOpenAgent({
                instanceId: geralt.id,
                tenantId: geralt.tenantId,
                agentName: geralt.agentName,
              })
          : undefined
      }
      onClose={onClose}
    />
  );
}
