import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWorkbenchAgents } from './use-workflow';
import type { AgentInstance } from './use-workflow';

export type GammaTemplate = {
  id: string;
  gammaId: string;
  name: string;
  description: string;
};

export function useGammaTemplates() {
  return useQuery<GammaTemplate[]>({
    queryKey: ['gamma-templates'],
    queryFn: () => api<GammaTemplate[]>('GET', '/gamma/templates'),
    staleTime: 5 * 60 * 1000,
  });
}

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

type TemplateStepBody = {
  step: 'template';
  templateId?: string;
  audience?: string;
  tone?: string;
  goal?: string;
};

type SourceStepBody = {
  step: 'source';
  transcriptSource: 'paste' | 'granola' | 'artifact';
  transcript?: string;
  granolaId?: string;
  sourceArtifactId?: string;
  callTitle?: string;
};

type GenerateStepBody = {
  step: 'generate';
  agentInstanceId: string;
};

type PresentationStepBody = TemplateStepBody | SourceStepBody | GenerateStepBody;

type StepMutationArgs = PresentationStepBody & { workflowId: string };

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
