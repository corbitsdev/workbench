import { logger } from './logger';

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  const init: RequestInit = { method, credentials: 'include' };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  logger.info('API request', { method, url, body });

  const res = await fetch(url, init);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    logger.error('API request failed', { method, url, status: res.status, error: err.error });
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const data = (await res.json()) as T;
  logger.info('API response', { method, url, status: res.status });
  return data;
}
