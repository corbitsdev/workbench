import { logger } from './logger';

// Empty string means same-origin (frontend served from the API).
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? '';

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
  const url = new URL(
    `/api/v1/${path.replace(/^\//, '')}`,
    apiBase || window.location.origin
  ).toString();
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
  const url = new URL(
    `/api/v1/${path.replace(/^\//, '')}`,
    apiBase || window.location.origin
  );
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
