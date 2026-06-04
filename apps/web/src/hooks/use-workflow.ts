import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { logger } from '../lib/logger';
import type { WorkflowState } from '@workbench/shared';

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
      logger.info('Fetching workflow', { workflowId });
      const res = await api<FrontendWorkflowState>('GET', `/workflows/${workflowId}`);
      logger.info('Workflow fetched', { workflowId, currentStep: res.currentStep });
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
      artifactId?: string;
      feedback?: string;
    }) => {
      logger.info('Running step', { workflowId, step: step.step });
      const res = await api<FrontendWorkflowState>('POST', `/workflows/${workflowId}/steps`, step);
      logger.info('Step completed', { workflowId, step: step.step, currentStep: res.currentStep });
      return res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
    onError: (error) => {
      logger.error('Step failed', {
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

export function useUpdateCompanyName(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (companyName: string | null) => {
      return api<{ id: string; companyName: string | null }>(
        'PATCH',
        `/workflows/${workflowId}/company`,
        { companyName }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { transcript?: string; granolaId?: string; source: string }) => {
      logger.info('Creating workflow', { source: body.source });
      const res = await api<FrontendWorkflowState>('POST', '/workflows', body);
      logger.info('Workflow created', { workflowId: res.id });
      return res;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workflow', data.id] });
    },
    onError: (error) => {
      logger.error('Workflow creation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
