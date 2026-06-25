import { type } from 'arktype';
import { logger } from './logger';

// Empty string means same-origin (frontend served from the API).
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? '';

// Single source of truth for the hub origin: explicit base, else same-origin.
function resolveBase(): string {
  return apiBase || window.location.origin;
}

export function buildApiUrl(path: string): string {
  return new URL(`/api/v1/${path.replace(/^\//, '')}`, resolveBase()).toString();
}

// Root-level (non-/api/v1) hub paths, e.g. /version. Same base-URL rules.
export function buildRootUrl(path: string): string {
  return new URL(`/${path.replace(/^\//, '')}`, resolveBase()).toString();
}

const VersionResponse = type({
  buildSha: 'string | null',
});

// Fetches the hub's live build SHA from the root-level /version route (null in
// local dev). Lives here so the page module makes no raw fetch.
export async function fetchBuildSha(): Promise<string | null> {
  const res = await fetch(buildRootUrl('/version'), { credentials: 'include' });
  if (!res.ok) throw new Error(`Version check failed: HTTP ${res.status}`);
  const raw: unknown = await res.json();
  const parsed = VersionResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected /version response: ${parsed.summary}`);
  }
  return parsed.buildSha;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = buildApiUrl(path);
  const init: RequestInit = { method, credentials: 'include' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  logger.info('API request', { method, url });

  const res = await fetch(url, init);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    logger.error('API request failed', { method, url, status: res.status, error: message });
    throw new ApiError(message, res.status);
  }

  const data = (await res.json()) as T;
  logger.info('API response', { method, url, status: res.status });
  return data;
}

// Multipart upload seam. `api()` JSON-encodes its body, so a file upload needs
// its own path: a FormData POST with no explicit Content-Type (the browser sets
// the multipart boundary). Shares the base-URL and error-handling rules.
export async function uploadFile<T>(
  path: string,
  file: File,
  options?: { tenantId?: string | null }
): Promise<T> {
  const url = new URL(`/api/v1/${path.replace(/^\//, '')}`, resolveBase());
  if (options?.tenantId) {
    url.searchParams.set('tenantId', options.tenantId);
  }
  const urlString = url.toString();
  const form = new FormData();
  form.set('file', file);

  logger.info('API upload', { url: urlString, filename: file.name, size: file.size });

  const res = await fetch(urlString, { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    logger.error('API upload failed', { url: urlString, status: res.status, error: message });
    throw new ApiError(message, res.status);
  }

  return (await res.json()) as T;
}

export async function uploadForm<T>(
  path: string,
  form: FormData,
  options?: { tenantId?: string | null }
): Promise<T> {
  const url = new URL(`/api/v1/${path.replace(/^\//, '')}`, resolveBase());
  if (options?.tenantId) {
    url.searchParams.set('tenantId', options.tenantId);
  }
  const urlString = url.toString();
  logger.info('API form upload', { url: urlString });

  const res = await fetch(urlString, { method: 'POST', credentials: 'include', body: form });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const message =
      body !== null &&
      typeof body === 'object' &&
      'error' in body &&
      typeof (body as Record<string, unknown>).error === 'string'
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    logger.error('API form upload failed', { url: urlString, status: res.status, error: message });
    throw new ApiError(message, res.status);
  }

  return (await res.json()) as T;
}
