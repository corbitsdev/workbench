import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { logger } from '../lib/logger';
import { listWorkbenches, listAgentInstances } from '../lib/hub-api';
import type { AgentInstance } from '../lib/hub-api';
import type { WorkflowState } from '@workbench/shared';

export type { AgentInstance };

export interface StepConfig {
  agentId?: string;
  toolIds?: string[];
}

export interface WorkflowStepConfig {
  analyze?: StepConfig;
  generate?: StepConfig;
  improve?: StepConfig;
}

export interface WorkflowTypeDefinition {
  kind: string;
  name: string;
  description: string;
}

export type StepName = 'intake' | 'analyze' | 'generate' | 'improve' | 'export';

export interface WorkflowStep {
  completed: boolean;
  [key: string]: unknown;
}

export interface FrontendWorkflowState extends WorkflowState {
  currentStep: StepName;
  steps: Record<StepName, WorkflowStep>;
  stepConfig: WorkflowStepConfig;
}

export function useWorkflowTypes() {
  return useQuery<WorkflowTypeDefinition[]>({
    queryKey: ['workflow-types'],
    queryFn: () => api<WorkflowTypeDefinition[]>('GET', '/workflows/types'),
    staleTime: 5 * 60 * 1000,
  });
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

export interface ExportStepResult {
  id: string;
  status: string;
  currentStep: 'export';
  export: {
    target: string;
    content: string;
    artifacts: unknown[];
  };
}

export type RunStepResult = FrontendWorkflowState | ExportStepResult;

export function isExportStepResult(r: RunStepResult): r is ExportStepResult {
  return 'export' in r && typeof (r as ExportStepResult).export?.content === 'string';
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
      const res = await api<RunStepResult>('POST', `/workflows/${workflowId}/steps`, step);
      logger.info('Step completed', { workflowId, step: step.step });
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

export function useUpdateStepConfig(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (stepConfig: WorkflowStepConfig) => {
      return api<{ id: string; stepConfig: WorkflowStepConfig }>(
        'PATCH',
        `/workflows/${workflowId}/step-config`,
        { stepConfig }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
    onError: (error) => {
      logger.error('Step config update failed', {
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

export function useWorkspaceAgents() {
  return useQuery<AgentInstance[]>({
    queryKey: ['workspace-agents'],
    queryFn: async () => {
      const workbenches = await listWorkbenches();
      const agentLists = await Promise.all(
        workbenches.map((w) => listAgentInstances(w.tenantId).catch((): AgentInstance[] => []))
      );
      return agentLists.flat();
    },
    staleTime: 60 * 1000,
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      transcript?: string;
      granolaId?: string;
      source: string;
      workflowKind?: string;
    }) => {
      const payload = { workflowKind: 'collateral-generation', ...body };
      logger.info('Creating workflow', {
        source: payload.source,
        workflowKind: payload.workflowKind,
      });
      const res = await api<FrontendWorkflowState>('POST', '/workflows', payload);
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
