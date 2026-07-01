import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import {
  GammaTemplateSchema,
  GammaTemplateBodySchema,
  type GammaTemplate,
  type GammaTemplateBody,
} from "@workbench/shared";
import { api } from "../lib/api";

export { GammaTemplateSchema, GammaTemplateBodySchema, type GammaTemplate };

const GammaTemplateArraySchema = GammaTemplateSchema.array();
const OkResponseSchema = type({ ok: "boolean" });

// The create/update request body — the canonical shared shape, not a local
// duplicate.
export type GammaTemplateInput = GammaTemplateBody;

function withTenant(path: string, tenantId?: string | null): string {
  return tenantId ? `${path}?tenantId=${encodeURIComponent(tenantId)}` : path;
}

function parseTemplate(raw: unknown): GammaTemplate {
  const parsed = GammaTemplateSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected gamma-template response: ${parsed.summary}`);
  }
  return parsed;
}

function parseOk(raw: unknown): { ok: boolean } {
  const parsed = OkResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected gamma-template response: ${parsed.summary}`);
  }
  return parsed;
}

export function useGammaTemplates(tenantId?: string | null) {
  return useQuery<GammaTemplate[]>({
    queryKey: ["gamma-templates", tenantId ?? null],
    queryFn: async () => {
      const raw = await api<unknown>(
        "GET",
        withTenant("/gamma-templates", tenantId),
      );
      const parsed = GammaTemplateArraySchema(raw);
      if (parsed instanceof type.errors) {
        throw new Error(
          `Unexpected gamma-templates response: ${parsed.summary}`,
        );
      }
      return parsed;
    },
    enabled: tenantId !== null && tenantId !== undefined,
    staleTime: 5 * 60_000,
  });
}

export function useCreateGammaTemplate(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GammaTemplateInput) =>
      parseTemplate(
        await api<unknown>(
          "POST",
          withTenant("/gamma-templates", tenantId),
          input,
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] }),
  });
}

export function useUpdateGammaTemplate(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; input: GammaTemplateInput }) =>
      parseTemplate(
        await api<unknown>(
          "PUT",
          withTenant(
            `/gamma-templates/${encodeURIComponent(vars.id)}`,
            tenantId,
          ),
          vars.input,
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] }),
  });
}

export function useDeleteGammaTemplate(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      parseOk(
        await api<unknown>(
          "DELETE",
          withTenant(`/gamma-templates/${encodeURIComponent(id)}`, tenantId),
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] }),
  });
}

// Grants manage access on a template to another principal. The settings page
// drives this from a member picker (name -> principal id via GET /members).
export function useDelegateGammaTemplate(tenantId?: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; principalId: string }) =>
      parseOk(
        await api<unknown>(
          "POST",
          withTenant(
            `/gamma-templates/${encodeURIComponent(vars.id)}/delegates`,
            tenantId,
          ),
          { principalId: vars.principalId },
        ),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["gamma-templates"] }),
  });
}
