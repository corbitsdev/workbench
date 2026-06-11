/**
 * Browserbase session lifecycle + config resolution.
 *
 * Sessions live on Browserbase. We create them via the REST API, reconstruct
 * the CDP connect URL deterministically from `apiKey + sessionId` (no stored
 * connection state), and release them via the REST API. A hard `timeout` is set
 * at creation as the real orphan-session backstop: it survives a hub crash, an
 * agent eviction, or a dropped socket, because it runs on Browserbase's side.
 */
import type { BrowserFetch, BrowserToolsConfig, ResolvedBrowserConfig } from './types';
import { realConnector } from './connect';

const DEFAULT_BASE_URL = 'https://api.browserbase.com/v1';
const CONNECT_HOST = 'wss://connect.browserbase.com';

/** Browserbase session duration ceiling, in seconds. */
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 600;
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

export function buildConnectUrl(apiKey: string, sessionId: string): string {
  const params = new URLSearchParams({ apiKey, sessionId });
  return `${CONNECT_HOST}?${params.toString()}`;
}

export async function createSession(
  config: ResolvedBrowserConfig,
  timeoutSeconds: number,
  signal: AbortSignal
): Promise<{ sessionId: string }> {
  const response = await config.fetcher(`${config.baseUrl}/sessions`, {
    method: 'POST',
    headers: browserbaseHeaders(config.apiKey),
    body: JSON.stringify({ projectId: config.projectId, timeout: timeoutSeconds }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Browserbase API error: ${response.status} ${await errorDetail(response)}`);
  }
  const data: unknown = await response.json();
  if (!isRecord(data) || typeof data.id !== 'string' || data.id.length === 0) {
    throw new Error('Browserbase session response missing id');
  }
  return { sessionId: data.id };
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

export type { BrowserFetch };
