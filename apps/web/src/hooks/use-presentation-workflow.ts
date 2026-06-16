import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { PresentationStepArgs, GammaTemplate } from "@workbench/workflow";

export { type PresentationStepArgs, type GammaTemplate };

export function useGammaTemplates({
  enabled = true,
}: { enabled?: boolean } = {}) {
  return useQuery<GammaTemplate[]>({
    queryKey: ["gamma-templates"],
    queryFn: () => api<GammaTemplate[]>("GET", "/workflows/gamma/templates"),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateGammaTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      gammaId: string;
      systemPrompt: string;
    }) => api<GammaTemplate>("POST", "/gamma-templates", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] });
      queryClient.invalidateQueries({ queryKey: ["gamma-templates-manage"] });
    },
  });
}

export function useUpdateGammaTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name: string;
      gammaId: string;
      systemPrompt: string;
    }) => api<GammaTemplate>("PUT", `/gamma-templates/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] });
      queryClient.invalidateQueries({ queryKey: ["gamma-templates-manage"] });
    },
  });
}

export function useDeleteGammaTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean }>("DELETE", `/gamma-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] });
      queryClient.invalidateQueries({ queryKey: ["gamma-templates-manage"] });
    },
  });
}

export function useManageGammaTemplates() {
  return useQuery<GammaTemplate[]>({
    queryKey: ["gamma-templates-manage"],
    queryFn: () => api<GammaTemplate[]>("GET", "/gamma-templates"),
    staleTime: 0,
  });
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
      return api<PresentationWorkflowRun>("POST", "/workflows", {
        workflowKind: "presentation-generation",
        ...(body.tenantId ? { tenantId: body.tenantId } : {}),
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["workflow", data.id] });
    },
  });
}

type StepMutationArgs = PresentationStepArgs & { workflowId: string };

export function useSubmitPresentationStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ workflowId, ...body }: StepMutationArgs) => {
      return api<{ status: string }>(
        "POST",
        `/workflows/${workflowId}/steps`,
        body,
      );
    },
    onSuccess: (_data, { workflowId }) => {
      queryClient.invalidateQueries({ queryKey: ["workflow", workflowId] });
    },
  });
}
