import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import { api, ApiError, uploadFile } from '../lib/api';
import { logger } from '../lib/logger';
import { listWorkbenches, listAgentInstances } from '../lib/hub-api';
import type { AgentInstance } from '../lib/hub-api';
import type { WorkflowState } from '@workbench/shared';

export type { AgentInstance };

export interface StepConfig {
  agentId?: string;
  toolIds?: string[];
  maxOutputTokens?: number;
}

export interface WorkflowStepConfig {
  analyze?: StepConfig;
  generate?: StepConfig;
}

export interface WorkflowTypeDefinition {
  kind: string;
  name: string;
  description: string;
}

export type StepName = 'intake' | 'analyze' | 'generate';

export interface WorkflowStep {
  completed: boolean;
  [key: string]: unknown;
}

export interface FrontendWorkflowState extends WorkflowState {
  currentStep: StepName;
  steps: Record<StepName, WorkflowStep>;
  stepConfig: WorkflowStepConfig;
  errorMessage?: string | null;
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
    retry: (_, error) => !(error instanceof ApiError && error.status === 404),
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      // Terminal ('done'/'failed') and quiescent human-wait ('ready', awaiting
      // the user's generate selection) states do not change server-side, so
      // stop polling. 'reviewing' keeps polling so a completion driven by
      // another client is observed.
      const status = data.status;
      const settled = status === 'done' || status === 'failed' || status === 'ready';
      return settled ? false : 5000;
    },
  });
}

export type RunStepResult = FrontendWorkflowState;

export function useRunStep(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (step: {
      step: StepName;
      painPointIds?: string[];
      collateralTypes?: string[];
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

export function useApproveArtifact(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      artifactId,
      status,
    }: {
      artifactId: string;
      status: 'approved' | 'rejected';
    }) => {
      return api<unknown>('PATCH', `/workflows/${workflowId}/artifacts/${artifactId}/status`, {
        status,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
    },
  });
}

export function useUpdateSelection(workflowId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      artifactId,
      chosen,
    }: {
      artifactId: string;
      chosen: Record<string, number>;
    }) => {
      return api<unknown>('PATCH', `/workflows/${workflowId}/artifacts/${artifactId}/selection`, {
        chosen,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
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

export interface WorkflowCredentialRequirement {
  providerName: string;
  source: string;
  name?: string;
  scopes?: string[];
  defaultModel?: string;
}

export interface WorkflowStepDefinition {
  name: string;
  label: string;
  description?: string;
  credentialRequirements: WorkflowCredentialRequirement[];
  tools?: string[];
}

export interface WorkflowCatalogEntry {
  kind: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  credentialRequirements: WorkflowCredentialRequirement[];
}

export interface StepAssignment {
  credentialIds: string[];
  toolIds: string[];
  model?: string;
}

export type WorkflowAssignments = Record<string, StepAssignment>;

export interface WorkflowInferenceCredential {
  id: string;
  name: string;
  providerName: string;
  providerPlugin: string;
  baseURL: string;
}

export interface EnabledWorkflowEntry {
  id: string;
  tenantId: string;
  kind: string;
  enabledAt: string;
  name: string;
  description: string;
  assignments: WorkflowAssignments;
}

export interface WorkflowToolMeta {
  name: string;
  providerName: string;
  description: string;
}

export function useWorkflowCredentials() {
  return useQuery<WorkflowInferenceCredential[]>({
    queryKey: ['workflow-credentials'],
    queryFn: () => api<WorkflowInferenceCredential[]>('GET', '/workflows/credentials'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useWorkflowCatalog() {
  return useQuery<WorkflowCatalogEntry[]>({
    queryKey: ['workflow-catalog'],
    queryFn: () => api<WorkflowCatalogEntry[]>('GET', '/workflows/catalog'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useWorkflowTools() {
  return useQuery<WorkflowToolMeta[]>({
    queryKey: ['workflow-tools'],
    queryFn: () => api<WorkflowToolMeta[]>('GET', '/workflows/tools'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useEnabledWorkflows(tenantId?: string | null) {
  return useQuery<EnabledWorkflowEntry[]>({
    queryKey: ['enabled-workflows', tenantId ?? null],
    queryFn: () =>
      api<EnabledWorkflowEntry[]>(
        'GET',
        tenantId
          ? `/workflows/enabled?tenantId=${encodeURIComponent(tenantId)}`
          : '/workflows/enabled'
      ),
    staleTime: 60 * 1000,
  });
}

export function useInstallWorkflow(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: string; assignments: WorkflowAssignments }) => {
      return api<EnabledWorkflowEntry>('POST', '/workflows/enabled', {
        kind: input.kind,
        assignments: input.assignments,
        ...(tenantId ? { tenantId } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['enabled-workflows'] });
    },
    onError: (error) => {
      logger.error('Workflow install failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

export function useWorkbenchAgents({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<AgentInstance[]>({
    queryKey: ['workbench-agents'],
    enabled,
    queryFn: async () => {
      const workbenches = await listWorkbenches();
      const agentLists = await Promise.all(
        workbenches.map((w) =>
          listAgentInstances(w.tenantId).catch((err): AgentInstance[] => {
            logger.warn('Failed to list agent instances for workbench', {
              tenantId: w.tenantId,
              error: err instanceof Error ? err.message : String(err),
            });
            return [];
          })
        )
      );
      return agentLists.flat();
    },
    staleTime: 60 * 1000,
  });
}

const uploadResultSchema = type({
  uploadId: 'string',
  filename: 'string',
  mimeType: 'string',
  size: 'number',
});
export type UploadResult = typeof uploadResultSchema.infer;

export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: File): Promise<UploadResult> => {
      const raw = await uploadFile<unknown>('/uploads', file);
      const parsed = uploadResultSchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected upload response: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      transcript?: string;
      granolaId?: string;
      sourceArtifactId?: string;
      uploadId?: string;
      source?: string;
      workflowKind: string;
      tenantId?: string;
    }) => {
      logger.info('Creating workflow', {
        source: body.source,
        workflowKind: body.workflowKind,
      });
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
