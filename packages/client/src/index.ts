// @workbench/client — framework-agnostic data-access seam for the workbench hub.
//
// These functions are the reusable boundary: any app or demo can point them at
// its own hub by passing a `baseUrl` and/or a custom `fetch`. They return clean
// `@workbench/shared` domain types and contain no presentation logic.

import { type } from 'arktype';
import type { ArtifactStatus, ArtifactWithSession, WorkflowSummary } from '@workbench/shared';

/** Configuration for a client call. All fields are optional. */
export interface ClientOptions {
  /**
   * Origin of the hub, e.g. `https://hub.example.com`. When omitted, requests
   * are made relative to the current origin (same-origin deployment).
   */
  baseUrl?: string;
  /** Custom fetch implementation (e.g. for tests or non-browser runtimes). */
  fetch?: typeof fetch;
  /** Forwarded to the underlying request (headers, signal, credentials, ...). */
  init?: RequestInit;
}

const API_PREFIX = 'api/v1';

function resolveUrl(path: string, baseUrl?: string): string {
  const cleanPath = path.replace(/^\//, '');
  const origin =
    baseUrl ??
    (typeof globalThis.location !== 'undefined' ? globalThis.location.origin : undefined);
  if (!origin) {
    throw new Error(
      'Cannot resolve request URL: no baseUrl provided and no global location available.'
    );
  }
  return new URL(`/${API_PREFIX}/${cleanPath}`, origin).toString();
}

async function request<T>(path: string, options: ClientOptions): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const url = resolveUrl(path, options.baseUrl);
  const init: RequestInit = { method: 'GET', credentials: 'include', ...options.init };

  const res = await doFetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const TenantMemberSchema = type({ id: 'string', name: 'string' });
const MembersResponseSchema = type({ members: TenantMemberSchema.array() });

export type TenantMember = typeof TenantMemberSchema.infer;

export interface ListMembersParams {
  tenantId?: string | null;
}

/** Fetch user principals for a tenant (`GET /members`). */
export async function listMembers(
  options: ClientOptions = {},
  params: ListMembersParams = {}
): Promise<TenantMember[]> {
  const search = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  const raw = await request<unknown>(`members${search}`, options);
  const parsed = MembersResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /members response: ${parsed.summary}`);
  }
  return parsed.members;
}

export interface ListWorkflowsParams {
  tenantId?: string | null;
}

export interface ListArtifactsParams {
  tenantId?: string | null;
  query?: string;
  sort?: 'newest' | 'oldest';
  kind?: string;
  status?: ArtifactStatus;
  ownerPrincipalId?: string;
  cursor?: string;
  limit?: number;
}

export interface ArtifactsPage {
  artifacts: ArtifactWithSession[];
  nextCursor: string | null;
}

const WorkflowRunRowSchema = type({
  deploymentId: 'string',
  kind: 'string',
  status: 'string',
  createdAt: 'string',
});
const WorkflowRunsResponseSchema = WorkflowRunRowSchema.array();

/**
 * Fetch the tenant's natively-deployed workflows (`GET /workflow-runs`).
 * The route scopes by the caller's tenant via the session, so `tenantId` is
 * not forwarded; it stays on the params only to gate the React Query hook.
 */
export async function listWorkflows(
  options: ClientOptions = {},
  _params: ListWorkflowsParams = {}
): Promise<WorkflowSummary[]> {
  const raw = await request<unknown>('workflow-runs', options);
  const parsed = WorkflowRunsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /workflow-runs response: ${parsed.summary}`);
  }
  return parsed.map((row) => ({
    id: row.deploymentId,
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
  }));
}

export type SkillItem = {
  id: string;
  name: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface ListSkillsParams {
  tenantId?: string | null;
}

export interface CreateSkillParams {
  tenantId?: string | null;
  name: string;
  description?: string | null;
  text: string;
}

export interface UpdateSkillParams {
  tenantId?: string | null;
  assetId: string;
  description?: string | null;
  text: string;
}

export interface AttachSkillParams {
  tenantId?: string | null;
  agentId: string;
  assetId: string;
}

export interface DetachSkillParams {
  tenantId?: string | null;
  agentId: string;
  assetId: string;
}

const SkillItemSchema = type({
  id: 'string',
  name: 'string',
  displayName: 'string | null',
  createdAt: 'string',
  updatedAt: 'string',
});

const SkillsResponseSchema = type({ skills: SkillItemSchema.array() });
const SkillResponseSchema = type({ skill: SkillItemSchema });

export async function listSkills(
  options: ClientOptions = {},
  params: ListSkillsParams = {}
): Promise<SkillItem[]> {
  const search = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  const raw = await request<unknown>(`skills${search}`, options);
  const parsed = SkillsResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skills;
}

export async function createSkill(
  options: ClientOptions = {},
  params: CreateSkillParams
): Promise<SkillItem> {
  const qs = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  const raw = await request<unknown>(`skills${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        text: params.text,
      }),
      headers: { 'Content-Type': 'application/json', ...options.init?.headers },
    },
  });
  const parsed = SkillResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skill;
}

export async function updateSkill(
  options: ClientOptions = {},
  params: UpdateSkillParams
): Promise<SkillItem> {
  const qs = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  const raw = await request<unknown>(`skills${qs}`, {
    ...options,
    init: {
      ...options.init,
      method: 'POST',
      body: JSON.stringify({
        assetId: params.assetId,
        description: params.description,
        text: params.text,
      }),
      headers: { 'Content-Type': 'application/json', ...options.init?.headers },
    },
  });
  const parsed = SkillResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid /skills response: ${parsed.summary}`);
  }
  return parsed.skill;
}

export async function attachSkill(
  options: ClientOptions = {},
  params: AttachSkillParams
): Promise<void> {
  const qs = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  await request<unknown>(`agents/${params.agentId}/skills/${params.assetId}${qs}`, {
    ...options,
    init: { ...options.init, method: 'POST' },
  });
}

export async function detachSkill(
  options: ClientOptions = {},
  params: DetachSkillParams
): Promise<void> {
  const qs = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  await request<unknown>(`agents/${params.agentId}/skills/${params.assetId}${qs}`, {
    ...options,
    init: { ...options.init, method: 'DELETE' },
  });
}

/**
 * Fetch the current user's artifacts across all their jobs, each enriched
 * with the originating job (`GET /artifacts`).
 */
export function listArtifacts(
  options: ClientOptions = {},
  params: ListArtifactsParams = {}
): Promise<ArtifactsPage> {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  if (params.query) qs.set('query', params.query);
  if (params.sort) qs.set('sort', params.sort);
  if (params.kind) qs.set('kind', params.kind);
  if (params.status) qs.set('status', params.status);
  if (params.ownerPrincipalId) qs.set('ownerPrincipalId', params.ownerPrincipalId);
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  const search = qs.size > 0 ? `?${qs.toString()}` : '';
  return request<ArtifactsPage>(`artifacts${search}`, options);
}
