import { OPERATION_BUDGET_MS } from './budgets';
import type { BrowserToolsConfig, ResolvedBrowserConfig } from './types';

export const DEFAULT_BASE_URL = 'https://api.browserbase.com/v1';

// Short by default: with keepAlive, an abandoned session burns this much paid
// browser-time before Browserbase auto-releases it.
export const DEFAULT_SESSION_TIMEOUT_SECONDS = 180;
export const MIN_SESSION_TIMEOUT_SECONDS = 60;
export const MAX_SESSION_TIMEOUT_SECONDS = 3600;

// The hub passes one `baseURL` per credential; the project id rides on it as
// `?projectId=`. Split it back into a clean REST base + project id.
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
    operationBudgetMs: config.operationBudgetMs ?? OPERATION_BUDGET_MS,
  };
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
