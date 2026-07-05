import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import {
  AgentDefinitionsResponse,
  AuditListResponse,
  type AgentDefinitionSummary,
  type AuditRecord,
  type PrincipalGrantsResponse as PrincipalGrantsResponseType,
  type PrincipalSummary,
  type RoleSummary,
  type ToolDefinitionSummary,
  type WorkflowDefinitionSummary,
  PrincipalGrantsResponse,
  PrincipalListResponse,
  RoleListResponse,
  ToolDefinitionsResponse,
  WorkflowDefinitionsResponse,
} from "@workbench/shared";
import { api } from "../lib/api";

const CATALOG_STALE = 5 * 60_000;

function parse<T>(schema: (v: unknown) => T | type.errors, raw: unknown): T {
  const parsed = schema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected admin response: ${parsed.summary}`);
  }
  return parsed;
}

export function useWorkflowDefinitions(enabled: boolean) {
  return useQuery<WorkflowDefinitionSummary[]>({
    queryKey: ["admin", "definitions", "workflows"],
    enabled,
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(
        WorkflowDefinitionsResponse,
        await api("GET", "admin/definitions/workflows"),
      ).definitions,
  });
}

export function useAgentDefinitions(enabled: boolean) {
  return useQuery<AgentDefinitionSummary[]>({
    queryKey: ["admin", "definitions", "agents"],
    enabled,
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(
        AgentDefinitionsResponse,
        await api("GET", "admin/definitions/agents"),
      ).definitions,
  });
}

export function useToolDefinitions(enabled: boolean) {
  return useQuery<ToolDefinitionSummary[]>({
    queryKey: ["admin", "definitions", "tools"],
    enabled,
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(
        ToolDefinitionsResponse,
        await api("GET", "admin/definitions/tools"),
      ).definitions,
  });
}

export function useAdminPrincipals(enabled: boolean) {
  return useQuery<PrincipalSummary[]>({
    queryKey: ["admin", "principals"],
    enabled,
    queryFn: async () =>
      parse(PrincipalListResponse, await api("GET", "admin/principals"))
        .principals,
  });
}

export function usePrincipalGrants(principalId: string | null) {
  return useQuery<PrincipalGrantsResponseType>({
    queryKey: ["admin", "principals", principalId, "grants"],
    enabled: principalId !== null,
    queryFn: async () =>
      parse(
        PrincipalGrantsResponse,
        await api("GET", `admin/principals/${principalId}/grants`),
      ),
  });
}

export function useAdminRoles(enabled: boolean) {
  return useQuery<RoleSummary[]>({
    queryKey: ["admin", "roles"],
    enabled,
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(RoleListResponse, await api("GET", "admin/roles")).roles,
  });
}

export function useAuditLog(enabled: boolean) {
  return useQuery<AuditRecord[]>({
    queryKey: ["admin", "audit"],
    enabled,
    queryFn: async () =>
      parse(AuditListResponse, await api("GET", "admin/audit")).records,
  });
}

// ─── Mutations ─────────────────────────────────────────────────────
//
// The only enforced management action is admin role assignment (elevate/demote)
// — every /admin route gates on full admin, so per-capability grant sharing is
// deferred to CL-2799.

function useInvalidatePrincipal() {
  const qc = useQueryClient();
  return (principalId: string) => {
    void qc.invalidateQueries({
      queryKey: ["admin", "principals", principalId, "grants"],
    });
    void qc.invalidateQueries({ queryKey: ["admin", "principals"] });
    void qc.invalidateQueries({ queryKey: ["admin", "audit"] });
    // The caller's own nav gate keys off /me.isAdmin — refresh it in case they
    // changed their own admin status.
    void qc.invalidateQueries({ queryKey: ["me"] });
  };
}

export function useElevateToAdmin() {
  const invalidate = useInvalidatePrincipal();
  return useMutation({
    mutationFn: async (vars: { principalId: string }) =>
      api("POST", `admin/principals/${vars.principalId}/elevate`),
    onSuccess: (_data, vars) => invalidate(vars.principalId),
  });
}

export function useDemoteFromAdmin() {
  const invalidate = useInvalidatePrincipal();
  return useMutation({
    mutationFn: async (vars: { principalId: string }) =>
      api("POST", `admin/principals/${vars.principalId}/demote`),
    onSuccess: (_data, vars) => invalidate(vars.principalId),
  });
}
