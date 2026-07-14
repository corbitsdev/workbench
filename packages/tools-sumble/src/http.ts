import type { SumbleFetch, SumbleToolsConfig } from "./types";

export const DEFAULT_BASE_URL = "https://api.sumble.com";
export const API_VERSION = "v9";
const MAX_POLL_ATTEMPTS = 10;
const DEFAULT_RETRY_AFTER_SECONDS = 2;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function v9Path(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.startsWith(`/${API_VERSION}/`)) {
    return normalized;
  }
  return `/${API_VERSION}${normalized}`;
}

export function sumbleHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function errorMessageFromBody(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    return text;
  }
  return text;
}

function parseRetryAfter(header: string | null): number {
  if (header === null) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return seconds;
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Sumble request aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Sumble request aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

export function sumbleUrl(config: SumbleToolsConfig, path: string): string {
  const base = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
  const legacyV8 = base.endsWith("/v8") || base.endsWith("/v8/");
  const resolvedPath = legacyV8
    ? path.startsWith("/")
      ? path
      : `/${path}`
    : v9Path(path);
  return `${normalizeBaseUrl(base)}${resolvedPath}`;
}

async function throwOnHttpError(response: Response): Promise<void> {
  if (response.ok) return;
  const bodyText = errorMessageFromBody(await response.text().catch(() => ""));
  const detail = response.statusText || bodyText;
  throw new Error(`Sumble API error: ${response.status} ${detail ?? ""}`);
}

export async function sumbleGet(
  config: SumbleToolsConfig,
  path: string,
  signal: AbortSignal,
  query?: Record<string, string | string[] | undefined>,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  let url = sumbleUrl(config, path);
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    if (qs.length > 0) {
      url = `${url}?${qs}`;
    }
  }
  const response = await fetcher(url, {
    method: "GET",
    headers: sumbleHeaders(config.apiKey),
    signal,
  } satisfies RequestInit);
  await throwOnHttpError(response);
  return response.json();
}

export async function sumblePost(
  config: SumbleToolsConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const response = await fetcher(sumbleUrl(config, path), {
    method: "POST",
    headers: sumbleHeaders(config.apiKey),
    body: JSON.stringify(body),
    signal,
  } satisfies RequestInit);
  await throwOnHttpError(response);
  return response.json();
}

function isAsyncPending(payload: unknown, is202: boolean): boolean {
  if (is202) return true;
  if (typeof payload !== "object" || payload === null) return false;
  const status = (payload as { status?: unknown }).status;
  return status === "pending" || status === "running";
}

export async function sumblePostAsync(
  config: SumbleToolsConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  const url = sumbleUrl(config, path);
  let nextBody: unknown = body;
  let attempts = 0;

  for (;;) {
    const response = await fetcher(url, {
      method: "POST",
      headers: sumbleHeaders(config.apiKey),
      body: JSON.stringify(nextBody),
      signal,
    } satisfies RequestInit);

    const is202 = response.status === 202;
    if (!is202) await throwOnHttpError(response);
    const payload: unknown = is202 ? null : await response.json();

    if (!isAsyncPending(payload, is202)) {
      return payload;
    }

    attempts += 1;
    if (attempts >= MAX_POLL_ATTEMPTS) {
      throw new Error(
        `Sumble ${path} did not complete after ${MAX_POLL_ATTEMPTS} polling attempts`,
      );
    }
    const requestId =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { request_id?: unknown }).request_id === "string"
        ? (payload as { request_id: string }).request_id
        : undefined;
    nextBody = requestId !== undefined ? { request_id: requestId } : body;
    await waitAbortable(
      parseRetryAfter(response.headers.get("Retry-After")) * 1000,
      signal,
    );
  }
}

export async function sumbleGetAsync(
  config: SumbleToolsConfig,
  path: string,
  signal: AbortSignal,
  query?: Record<string, string | string[] | undefined>,
): Promise<unknown> {
  const fetcher = config.fetcher ?? fetch;
  let url = sumbleUrl(config, path);
  if (query !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, item);
        }
      } else {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    if (qs.length > 0) {
      url = `${url}?${qs}`;
    }
  }
  let attempts = 0;

  for (;;) {
    const response = await fetcher(url, {
      method: "GET",
      headers: sumbleHeaders(config.apiKey),
      signal,
    } satisfies RequestInit);

    if (response.status === 202) {
      attempts += 1;
      if (attempts >= MAX_POLL_ATTEMPTS) {
        throw new Error(
          `Sumble ${path} did not complete after ${MAX_POLL_ATTEMPTS} polling attempts`,
        );
      }
      await waitAbortable(
        parseRetryAfter(response.headers.get("Retry-After")) * 1000,
        signal,
      );
      continue;
    }
    await throwOnHttpError(response);
    return response.json();
  }
}
