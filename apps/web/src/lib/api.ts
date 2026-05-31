import { logger } from './logger';

const apiBase: string | undefined = import.meta.env.VITE_API_BASE_URL;
if (!apiBase) throw new Error('Missing required env variable: VITE_API_BASE_URL');

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = new URL(`/api/v1/${path.replace(/^\//, '')}`, apiBase).toString();
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
