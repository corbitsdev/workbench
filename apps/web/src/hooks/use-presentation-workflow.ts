import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWorkbenchAgents } from './use-workflow';
import type { AgentInstance } from './use-workflow';
import type { PresentationStepArgs } from '@workbench/workflow';

export { type PresentationStepArgs };

export function useGeraltInstances() {
  const agents = useWorkbenchAgents();
  return {
    ...agents,
    data: agents.data?.filter((a: AgentInstance) => a.agentName === 'Geralt') ?? [],
  };
}

type PresentationWorkflowRun = {
  id: string;
  status: string;
  kind: string;
};

export function useCreatePresentationWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { tenantId?: string | null }) => {
      return api<PresentationWorkflowRun>('POST', '/workflows', {
        workflowKind: 'presentation-generation',
        ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workflow', data.id] });
    },
  });
}

type StepMutationArgs = PresentationStepArgs & { workflowId: string };

export function useSubmitPresentationStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ workflowId, ...body }: StepMutationArgs) => {
      return api<{ status: string }>('POST', `/workflows/${workflowId}/steps`, body);
    },
    onSuccess: (_data, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });
}
