import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import {
  AuditListResponse,
  DefinitionDetailResponse,
  DefinitionListResponse,
  type AdminAuditAction,
  type AuditListResponse as AuditListResponseType,
  type DefinitionDetailResponse as DefinitionDetailResponseType,
  type DefinitionKind,
  type DefinitionListResponse as DefinitionListResponseType,
  type PrincipalGrantsResponse as PrincipalGrantsResponseType,
  type PrincipalListResponse as PrincipalListResponseType,
  type PrincipalSummary,
  type RoleSummary,
  PrincipalDetailResponse,
  PrincipalGrantsResponse,
  PrincipalListResponse,
  RoleListResponse,
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

/** Build a `?a=b&...` query string, dropping empty/undefined values. */
function queryString(
  params: Record<string, string | number | undefined>,
): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

// ─── Definitions ───────────────────────────────────────────────────

export interface DefinitionFilters {
  page: number;
  limit: number;
  kind?: DefinitionKind;
  status?: string;
  search?: string;
}

export function useAdminDefinitions(filters: DefinitionFilters) {
  return useQuery<DefinitionListResponseType>({
    queryKey: ["admin", "definitions", filters],
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(
        DefinitionListResponse,
        await api("GET", `admin/definitions${queryString({ ...filters })}`),
      ),
  });
}

export function useDefinitionDetail(
  kind: DefinitionKind | null,
  key: string | null,
) {
  return useQuery<DefinitionDetailResponseType>({
    queryKey: ["admin", "definitions", kind, key],
    enabled: kind !== null && key !== null,
    staleTime: CATALOG_STALE,
    queryFn: async () =>
      parse(
        DefinitionDetailResponse,
        await api(
          "GET",
          `admin/definitions/${encodeURIComponent(key ?? "")}${queryString({
            kind: kind ?? undefined,
          })}`,
        ),
      ),
  });
}

// ─── Principals ────────────────────────────────────────────────────

export interface PrincipalFilters {
  page: number;
  limit: number;
  type?: "user" | "agent";
  search?: string;
}

export function useAdminPrincipals(filters: PrincipalFilters) {
  return useQuery<PrincipalListResponseType>({
    queryKey: ["admin", "principals", filters],
    queryFn: async () =>
      parse(
        PrincipalListResponse,
        await api("GET", `admin/principals${queryString({ ...filters })}`),
      ),
  });
}

export function usePrincipalDetail(principalId: string | null) {
  return useQuery<PrincipalSummary>({
    queryKey: ["admin", "principals", principalId, "detail"],
    enabled: principalId !== null,
    queryFn: async () =>
      parse(
        PrincipalDetailResponse,
        await api("GET", `admin/principals/${principalId}`),
      ).principal,
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

// ─── Audit ─────────────────────────────────────────────────────────

export interface AuditFilters {
  page: number;
  limit: number;
  actor?: string;
  action?: AdminAuditAction;
  from?: string;
  to?: string;
}

export function useAuditLog(filters: AuditFilters) {
  return useQuery<AuditListResponseType>({
    queryKey: ["admin", "audit", filters],
    queryFn: async () =>
      parse(
        AuditListResponse,
        await api("GET", `admin/audit${queryString({ ...filters })}`),
      ),
  });
}

// ─── Mutations ─────────────────────────────────────────────────────
//
// The only enforced management action is admin role assignment (elevate/demote)
// — every /admin route gates on full admin, so per-capability grant sharing is
// deferred to CL-2799.

function useInvalidatePrincipal() {
  const qc = useQueryClient();
  return () => {
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
    onSuccess: () => invalidate(),
  });
}

export function useDemoteFromAdmin() {
  const invalidate = useInvalidatePrincipal();
  return useMutation({
    mutationFn: async (vars: { principalId: string }) =>
      api("POST", `admin/principals/${vars.principalId}/demote`),
    onSuccess: () => invalidate(),
  });
}
