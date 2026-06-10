// @workbench/client — framework-agnostic data-access seam for the workbench hub.
//
// These functions are the reusable boundary: any app or demo can point them at
// its own hub by passing a `baseUrl` and/or a custom `fetch`. They return clean
// `@workbench/shared` domain types and contain no presentation logic.

import type { ArtifactWithSession, WorkflowSummary } from '@workbench/shared';

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

export interface ListWorkflowsParams {
  tenantId?: string | null;
}

export interface ListArtifactsParams {
  tenantId?: string | null;
  query?: string;
}

/** Fetch the current user's jobs (`GET /workflows`). */
export function listWorkflows(
  options: ClientOptions = {},
  params: ListWorkflowsParams = {}
): Promise<WorkflowSummary[]> {
  const search = params.tenantId ? `?tenantId=${encodeURIComponent(params.tenantId)}` : '';
  return request<WorkflowSummary[]>(`workflows${search}`, options);
}

/**
 * Fetch the current user's artifacts across all their jobs, each enriched
 * with the originating job (`GET /artifacts`).
 */
export function listArtifacts(
  options: ClientOptions = {},
  params: ListArtifactsParams = {}
): Promise<ArtifactWithSession[]> {
  const qs = new URLSearchParams();
  if (params.tenantId) qs.set('tenantId', params.tenantId);
  if (params.query) qs.set('query', params.query);
  const search = qs.size > 0 ? `?${qs.toString()}` : '';
  return request<ArtifactWithSession[]>(`artifacts${search}`, options);
}
