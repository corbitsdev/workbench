import type { AgentTool } from '@intx/agent';
import type { ToolDefinition } from '@intx/types/runtime';

export type GammaFetch = (input: string, init: RequestInit) => Promise<Response>;

// https://developers.gamma.app — base URL verified against live API docs
export const GAMMA_DEFAULT_BASE_URL = 'https://public-api.gamma.app/v1.0';

export type GammaToolsConfig = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: GammaFetch;
};

export type ResolvedGammaConfig = {
  apiKey: string;
  baseUrl: string;
  fetcher?: GammaFetch;
};

export function resolveConfig(config: GammaToolsConfig): ResolvedGammaConfig {
  const resolved: ResolvedGammaConfig = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl?.trim() || GAMMA_DEFAULT_BASE_URL,
    ...(config.fetcher ? { fetcher: config.fetcher } : {}),
  };
  validateConfig(resolved);
  return resolved;
}

function validateConfig(config: ResolvedGammaConfig): void {
  if (config.apiKey.length === 0) {
    throw new Error('Gamma apiKey is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(config.baseUrl);
  } catch {
    throw new Error('Gamma baseUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Gamma baseUrl must use HTTPS');
  }
}

// Gamma uses X-API-KEY header — not Authorization: Bearer
function gammaHeaders(apiKey: string): Record<string, string> {
  return {
    'X-API-KEY': apiKey,
    'Content-Type': 'application/json',
  };
}

export function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function stringTool(
  definition: ToolDefinition,
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
): AgentTool {
  return {
    kind: 'string',
    definition,
    handler: async (args, signal) => jsonResult(await call(args, signal)),
  };
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type GammaRequest = {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined> | undefined;
  body?: unknown;
};

export async function gammaFetchJSON(
  config: ResolvedGammaConfig,
  request: GammaRequest,
  signal?: AbortSignal
): Promise<unknown> {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}${request.path}`);
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(url.toString(), {
    method: request.method,
    headers: gammaHeaders(config.apiKey),
    signal,
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  } satisfies RequestInit);

  if (!response.ok) {
    const body = errorMessageFromBody(await response.text().catch(() => ''));
    const detail = body || response.statusText;
    throw new Error(`Gamma API error: ${response.status}${detail ? ` ${detail}` : ''}`);
  }

  return (await response.json()) as unknown;
}

const ERROR_BODY_MAX_LENGTH = 500;

export function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  const truncated =
    text.length > ERROR_BODY_MAX_LENGTH ? text.slice(0, ERROR_BODY_MAX_LENGTH) + '…' : text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.error === 'string') {
        return parsed.error;
      }
      if (typeof parsed.message === 'string') {
        return parsed.message;
      }
    }
  } catch {
    return truncated;
  }
  return truncated;
}

const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 100; // ~5 minutes

export type GenerationStatus = 'pending' | 'completed' | 'failed';

export type GenerationResult = {
  gammaUrl: string;
  gammaId: string;
};

export async function pollGeneration(
  config: ResolvedGammaConfig,
  generationId: string,
  signal: AbortSignal
): Promise<GenerationResult> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      throw new Error('Generation polling aborted');
    }

    const result = await gammaFetchJSON(
      config,
      { method: 'GET', path: `/generations/${generationId}` },
      signal
    );

    if (!isRecord(result)) {
      throw new Error(`Unexpected generation status response`);
    }

    const status = result['status'] as GenerationStatus | undefined;

    if (status === 'completed') {
      const gammaUrl = result['gammaUrl'];
      const gammaId = result['gammaId'];
      if (typeof gammaUrl !== 'string' || typeof gammaId !== 'string') {
        throw new Error('Generation completed but gammaUrl or gammaId is missing');
      }
      return { gammaUrl, gammaId };
    }

    if (status === 'failed') {
      throw new Error('Gamma generation failed');
    }

    await sleep(POLL_INTERVAL_MS, signal);
  }

  throw new Error('Gamma generation timed out');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}
