import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { WorkflowState } from '@gtm/workbench-shared';

export type StepName = 'intake' | 'analyze' | 'generate' | 'improve' | 'export';

export interface WorkflowStep {
  completed: boolean;
  [key: string]: unknown;
}

export interface FrontendWorkflowState extends WorkflowState {
  currentStep: StepName;
  steps: Record<StepName, WorkflowStep>;
}

export function useWorkflow(workflowId: string) {
  return useQuery<FrontendWorkflowState>({
    queryKey: ['workflow', workflowId],
    queryFn: async () => {
      const res = await api<FrontendWorkflowState>('GET', `/workflows/${workflowId}`);
      return res;
    },
    enabled: Boolean(workflowId),
  });
}

export function useRunStep(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (step: {
      step: StepName;
      painPointIds?: string[];
      collateralId?: string;
      feedback?: string;
    }) => {
      const res = await api<FrontendWorkflowState>('POST', `/workflows/${workflowId}/steps`, step);
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { transcript?: string; granolaId?: string; source: string }) => {
      const res = await api<FrontendWorkflowState>('POST', '/workflows', body);
      return res;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workflow', data.id] });
    },
  });
}
