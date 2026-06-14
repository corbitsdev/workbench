/**
 * Browserbase session lifecycle + config resolution.
 *
 * Sessions live on Browserbase. We create them via the REST API with
 * `keepAlive: true` so the session persists across the repeated connect /
 * disconnect calls each tool makes. The API returns a `connectUrl`; we store it
 * in a module-level Map keyed by sessionId so subsequent tools can use it
 * without exposing a credential-bearing URL to the model. A hard `timeout` is
 * set at creation as the real orphan-session backstop: it survives a hub crash,
 * an agent eviction, or a dropped socket, because it runs on Browserbase's side.
 */
import type { BrowserFetch, BrowserToolsConfig, ResolvedBrowserConfig } from './types';
import { OPERATION_BUDGET_MS, realConnector } from './connect';

const DEFAULT_BASE_URL = 'https://api.browserbase.com/v1';

/**
 * Server-side store mapping sessionId → Browserbase-provided connectUrl.
 * Lives for the process lifetime. Entries are removed when browser_close_session
 * is called. Tools are rebuilt on every hub /tools/run call, so this cannot live
 * in a closure.
 */
const SESSION_CONNECT_URLS = new Map<string, string>();

export function storeSessionConnectURL(sessionId: string, connectUrl: string): void {
  SESSION_CONNECT_URLS.set(sessionId, connectUrl);
}

export function lookupSessionConnectURL(sessionId: string): string {
  const url = SESSION_CONNECT_URLS.get(sessionId);
  if (url === undefined) {
    throw new Error(
      `No connectUrl for browser session "${sessionId}". Call browser_create_session first.`
    );
  }
  return url;
}

export function removeSessionConnectURL(sessionId: string): void {
  SESSION_CONNECT_URLS.delete(sessionId);
}

/** Clear all stored connect URLs. Intended for use in tests only. */
export function clearSessionConnectURLs(): void {
  SESSION_CONNECT_URLS.clear();
}

/**
 * Default session lifetime, in seconds. Kept short because sessions are created
 * with keepAlive and an abandoned one (agent crash, eviction, never-closed)
 * burns this much paid browser-time before Browserbase auto-releases it. On the
 * free tier's 1-hour monthly budget, a long default exhausts the allowance fast.
 */
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 180;
export const MIN_SESSION_TIMEOUT_SECONDS = 60;
export const MAX_SESSION_TIMEOUT_SECONDS = 3600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The hub passes a single `baseURL` string per credential. Browserbase also
 * needs a project id, so it rides as a `?projectId=` query param on the provider
 * metadata baseURL. Split it back into a clean REST base + project id here.
 */
export function parseBrowserbaseBaseURL(baseURL: string | undefined): {
  baseUrl: string;
  projectId: string | undefined;
} {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return { baseUrl: DEFAULT_BASE_URL, projectId: undefined };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Browserbase baseURL must be a valid URL');
  }
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/$/, '');
  return { baseUrl, projectId };
}

export function resolveConfig(config: BrowserToolsConfig): ResolvedBrowserConfig {
  if (config.apiKey.length === 0) {
    throw new Error('Browserbase apiKey is required');
  }
  const baseUrl = (config.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
  try {
    new URL(baseUrl);
  } catch {
    throw new Error('Browserbase baseUrl must be a valid URL');
  }
  const projectId = config.projectId?.trim();
  if (!projectId) {
    throw new Error(
      'Browserbase projectId is required — set it on the provider metadata baseURL as ?projectId=<id>'
    );
  }
  return {
    apiKey: config.apiKey,
    baseUrl,
    projectId,
    fetcher: config.fetcher ?? fetch,
    connector: config.connector ?? realConnector,
    operationBudgetMs: config.operationBudgetMs ?? OPERATION_BUDGET_MS,
  };
}

function browserbaseHeaders(apiKey: string): Record<string, string> {
  return {
    'X-BB-API-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text.length === 0) {
    return response.statusText || String(response.status);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    return text;
  }
  return text;
}

export function clampTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SESSION_TIMEOUT_SECONDS;
  }
  return Math.min(
    MAX_SESSION_TIMEOUT_SECONDS,
    Math.max(MIN_SESSION_TIMEOUT_SECONDS, Math.floor(value))
  );
}

export async function createSession(
  config: ResolvedBrowserConfig,
  timeoutSeconds: number,
  signal: AbortSignal
): Promise<{ sessionId: string; connectUrl: string }> {
  const response = await config.fetcher(`${config.baseUrl}/sessions`, {
    method: 'POST',
    headers: browserbaseHeaders(config.apiKey),
    body: JSON.stringify({ projectId: config.projectId, timeout: timeoutSeconds, keepAlive: true }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Browserbase API error: ${response.status} ${await errorDetail(response)}`);
  }
  const data: unknown = await response.json();
  if (!isRecord(data) || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('Browserbase session response missing id');
  }
  if (typeof data.connectUrl !== 'string' || data.connectUrl.length === 0) {
    throw new Error('Browserbase session response missing connectUrl');
  }
  return { sessionId: data.id, connectUrl: data.connectUrl };
}

export async function endSession(
  config: ResolvedBrowserConfig,
  sessionId: string,
  signal: AbortSignal
): Promise<void> {
  const response = await config.fetcher(`${config.baseUrl}/sessions/${sessionId}`, {
    method: 'POST',
    headers: browserbaseHeaders(config.apiKey),
    body: JSON.stringify({ projectId: config.projectId, status: 'REQUEST_RELEASE' }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Browserbase API error: ${response.status} ${await errorDetail(response)}`);
  }
}

export type BrowserbaseSession = {
  id: string;
  status: string;
  /** ISO timestamp; Browserbase returns startedAt for running sessions. */
  startedAt?: string;
  createdAt?: string;
};

function parseSession(value: unknown): BrowserbaseSession | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string') {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}),
  };
}

/** List the project's RUNNING sessions. */
export async function listRunningSessions(
  config: ResolvedBrowserConfig,
  signal: AbortSignal
): Promise<BrowserbaseSession[]> {
  const url = new URL(`${config.baseUrl}/sessions`);
  url.searchParams.set('status', 'RUNNING');
  const response = await config.fetcher(url.toString(), {
    method: 'GET',
    headers: browserbaseHeaders(config.apiKey),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Browserbase API error: ${response.status} ${await errorDetail(response)}`);
  }
  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Browserbase session list response is not an array');
  }
  return data.map(parseSession).filter((s): s is BrowserbaseSession => s !== null);
}

/**
 * Backstop cleanup beyond the per-session create timeout: release any RUNNING
 * session older than `maxAgeMs`. Run on a schedule (see
 * apps/hub/bin/reap-browser-sessions.ts). `nowMs` is injected so the logic is
 * deterministic and testable. Sessions with an unparseable age are left for the
 * Browserbase timeout to reap, never force-closed on a guess.
 */
export async function reapStaleSessions(
  config: ResolvedBrowserConfig,
  maxAgeMs: number,
  nowMs: number,
  signal: AbortSignal
): Promise<{ reaped: string[]; skipped: string[] }> {
  const sessions = await listRunningSessions(config, signal);
  const reaped: string[] = [];
  const skipped: string[] = [];
  for (const session of sessions) {
    const stamp = session.startedAt ?? session.createdAt;
    const startedMs = stamp ? Date.parse(stamp) : NaN;
    if (Number.isNaN(startedMs)) {
      skipped.push(session.id);
      continue;
    }
    if (nowMs - startedMs >= maxAgeMs) {
      await endSession(config, session.id, signal);
      reaped.push(session.id);
    }
  }
  return { reaped, skipped };
}

const TERMINAL_SESSION_STATUSES = new Set(['ERROR', 'TIMED_OUT', 'COMPLETED', 'CANCELLED']);

export type WaitForSessionRunningOptions = {
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

const DEFAULT_WAIT_FOR_RUNNING_MAX_MS = 30_000;
const DEFAULT_WAIT_FOR_RUNNING_POLL_MS = 1_000;

/**
 * Poll GET /sessions/{id} until status === RUNNING or a terminal/deadline condition fires.
 * The browser process starts asynchronously after POST /sessions; connecting CDP before
 * RUNNING produces a WebSocket timeout.
 */
export async function waitForSessionRunning(
  config: ResolvedBrowserConfig,
  sessionId: string,
  signal: AbortSignal,
  options?: WaitForSessionRunningOptions
): Promise<void> {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_WAIT_FOR_RUNNING_POLL_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_WAIT_FOR_RUNNING_MAX_MS;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const response = await config.fetcher(`${config.baseUrl}/sessions/${sessionId}`, {
      method: 'GET',
      headers: browserbaseHeaders(config.apiKey),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Browserbase API error: ${response.status} ${await errorDetail(response)}`);
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.status !== 'string') {
      throw new Error('Browserbase session status response missing status');
    }
    const status = data.status;
    if (status === 'RUNNING') {
      return;
    }
    if (TERMINAL_SESSION_STATUSES.has(status)) {
      throw new Error(`Browserbase session ${sessionId} reached terminal status: ${status}`);
    }
    if (pollIntervalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(`Browserbase session ${sessionId} did not reach RUNNING within ${maxWaitMs}ms`);
}

export type { BrowserFetch };
