import { type } from "arktype";
import { utf8ByteLength } from "@workbench/artifact";
import { logger } from "./logger";

// Empty string means same-origin (frontend served from the API).
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";

// Single source of truth for the hub origin: explicit base, else same-origin.
function resolveBase(): string {
  return apiBase || window.location.origin;
}

export function buildApiUrl(path: string): string {
  return new URL(
    `/api/v1/${path.replace(/^\//, "")}`,
    resolveBase(),
  ).toString();
}

// Root-level (non-/api/v1) hub paths, e.g. /version. Same base-URL rules.
export function buildRootUrl(path: string): string {
  return new URL(`/${path.replace(/^\//, "")}`, resolveBase()).toString();
}

// EventSource URL for an /api/v1 SSE route. ALWAYS same-origin — never apiBase —
// because a credentialed cross-origin EventSource is silently dropped by Safari
// ITP and Brave shields (the connection opens but frames never surface). The
// same-origin /api/v1 path is proxied to the hub in every environment: the Vite
// dev proxy locally, and the Vercel `/api/(.*)` → `${HUB_UPSTREAM_URL}` rewrite
// in prod (see vercel.json) — the same path the normal API client already rides
// in prod, where VITE_API_BASE_URL is empty so resolveBase() is same-origin too.
// The auth cookie is same-origin, so the proxied stream authenticates. (Regular
// fetch is unaffected and may still use apiBase directly in a split-origin dev.)
export function buildEventSourceUrl(path: string): string {
  return new URL(
    `/api/v1/${path.replace(/^\//, "")}`,
    window.location.origin,
  ).toString();
}

// Same-origin /api/v1 URL for a CREDENTIALED SUBRESOURCE (e.g. an <img>
// thumbnail). Like buildEventSourceUrl, it never uses apiBase: a browser does
// not attach the same-origin auth cookie to a cross-origin subresource, so an
// image request must ride the proxied same-origin /api/v1 path (the Vite dev
// proxy locally, the Vercel `/api/(.*)` rewrite in prod) where the cookie is
// sent. buildApiUrl is for fetch(), which sends credentials explicitly.
export function buildSameOriginApiUrl(path: string): string {
  return new URL(
    `/api/v1/${path.replace(/^\//, "")}`,
    window.location.origin,
  ).toString();
}

const VersionResponse = type({
  buildSha: "string | null",
});

// Fetches the hub's live build SHA from the root-level /version route (null in
// local dev). Lives here so the page module makes no raw fetch.
export async function fetchBuildSha(): Promise<string | null> {
  const res = await fetch(buildRootUrl("/version"), { credentials: "include" });
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
    public readonly status: number,
    // Machine-readable failure code from a nested { error: { code } } body
    // (e.g. the deploy-window 503 "deploy_in_progress", CL-2707). Undefined for
    // the flat { error: string } shape.
    public readonly code?: string,
    // Seconds the caller should wait before retrying, taken from the Retry-After
    // header (else a numeric body field). Undefined when no hint is present.
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function retryAfterFromHeader(res: Response): number | undefined {
  const header = res.headers.get("Retry-After");
  if (header === null || header.trim() === "") return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : undefined;
}

// Build an ApiError from a failed response + parsed body. Handles BOTH error
// shapes: the flat { error: string } every legacy failure returns, and the
// nested { error: { code, message } } the deploy-window 503 returns (CL-2707).
// A flat string stays the message with no code; a nested object surfaces its
// message plus the machine `code` and any retry hint so callers can auto-retry.
export function toApiError(res: Response, body: unknown): ApiError {
  const retryHeader = retryAfterFromHeader(res);
  if (body !== null && typeof body === "object" && "error" in body) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") {
      return new ApiError(err, res.status, undefined, retryHeader);
    }
    if (err !== null && typeof err === "object") {
      const nested = err as Record<string, unknown>;
      const message =
        typeof nested.message === "string"
          ? nested.message
          : `HTTP ${res.status}`;
      const code = typeof nested.code === "string" ? nested.code : undefined;
      const retryBody =
        typeof nested.retryAfterSeconds === "number"
          ? nested.retryAfterSeconds
          : undefined;
      return new ApiError(message, res.status, code, retryHeader ?? retryBody);
    }
  }
  return new ApiError(`HTTP ${res.status}`, res.status, undefined, retryHeader);
}

// True for the deploy-window 503 the hub returns while the sidecar reconnects
// after a redeploy (CL-2707). The FE auto-retries these rather than flashing an
// error, since the run resumes the moment the sidecar is back.
export function isDeployInProgress(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 503 &&
    err.code === "deploy_in_progress"
  );
}

const DEPLOY_RETRY_MAX_ATTEMPTS = 4;
const DEPLOY_RETRY_FALLBACK_SECONDS = 10;

// Run `fn`, auto-retrying only the deploy-window 503 with bounded backoff
// (respect Retry-After, else ~10s; capped attempts). `onRetrying` fires before
// each wait so the UI can show an honest transient "finishing an update" state.
// Any other error — or exhausting the attempts — rejects with the original
// error so normal failures surface their message and never silently spin.
export async function withDeployRetry<T>(
  fn: () => Promise<T>,
  opts?: {
    onRetrying?: () => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const sleep =
    opts?.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= DEPLOY_RETRY_MAX_ATTEMPTS || !isDeployInProgress(err)) {
        throw err;
      }
      opts?.onRetrying?.();
      const seconds = err.retryAfterSeconds ?? DEPLOY_RETRY_FALLBACK_SECONDS;
      await sleep(seconds * 1000);
    }
  }
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = buildApiUrl(path);
  const init: RequestInit = { method, credentials: "include" };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  logger.info("API request", { method, url });

  const res = await fetch(url, init);
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const apiError = toApiError(res, body);
    logger.error("API request failed", {
      method,
      url,
      status: res.status,
      error: apiError.message,
    });
    throw apiError;
  }

  const data = (await res.json()) as T;
  logger.info("API response", { method, url, status: res.status });
  return data;
}

// Outcome of a CSV preview fetch. The viewer already decided this artifact is a
// CSV (routing on stored mime / .csv extension), so the only boundary concern
// here is size: hand back the `csv` text to parse, or refuse a `too-large`
// payload up front. Whether the parsed text is actually tabular is decided
// downstream by the arktype narrow, not by re-sniffing the Content-Type — the
// download route echoes the stored upload mime, which for a real .csv is often a
// vendor mime (application/vnd.ms-excel, application/octet-stream, empty), so a
// strict text/csv check here would reject common legitimate uploads.
export type CsvPreviewResult =
  | { kind: "csv"; text: string }
  | { kind: "too-large"; bytes: number };

// Fetch an artifact's downloadable CSV text with a size guard. A non-ok response
// throws (same path as `api()`), so the caller's error branch can fall back to a
// download link. The declared Content-Length is refused BEFORE the body is read;
// a chunked response with no length header is read in full, then refused if its
// true UTF-8 byte length exceeds `maxBytes`.
export async function fetchCsvPreview(
  path: string,
  maxBytes: number,
): Promise<CsvPreviewResult> {
  const url = buildApiUrl(path);
  logger.info("API request", { method: "GET", url });

  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const apiError = toApiError(res, body);
    logger.error("API request failed", {
      method: "GET",
      url,
      status: res.status,
      error: apiError.message,
    });
    throw apiError;
  }

  const lengthHeader = res.headers.get("Content-Length");
  const declared = lengthHeader === null ? null : Number(lengthHeader);
  if (declared !== null && Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "too-large", bytes: declared };
  }

  const text = await res.text();
  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    return { kind: "too-large", bytes };
  }
  return { kind: "csv", text };
}

// Multipart upload seam. `api()` JSON-encodes its body, so a file upload needs
// its own path: a FormData POST with no explicit Content-Type (the browser sets
// the multipart boundary). Shares the base-URL and error-handling rules.
export async function uploadFile<T>(
  path: string,
  file: File,
  options?: { tenantId?: string | null },
): Promise<T> {
  const url = new URL(`/api/v1/${path.replace(/^\//, "")}`, resolveBase());
  if (options?.tenantId) {
    url.searchParams.set("tenantId", options.tenantId);
  }
  const urlString = url.toString();
  const form = new FormData();
  form.set("file", file);

  logger.info("API upload", {
    url: urlString,
    filename: file.name,
    size: file.size,
  });

  const res = await fetch(urlString, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const apiError = toApiError(res, body);
    logger.error("API upload failed", {
      url: urlString,
      status: res.status,
      error: apiError.message,
    });
    throw apiError;
  }

  return (await res.json()) as T;
}

export async function uploadForm<T>(
  path: string,
  form: FormData,
  options?: { tenantId?: string | null },
): Promise<T> {
  const url = new URL(`/api/v1/${path.replace(/^\//, "")}`, resolveBase());
  if (options?.tenantId) {
    url.searchParams.set("tenantId", options.tenantId);
  }
  const urlString = url.toString();
  logger.info("API form upload", { url: urlString });

  const res = await fetch(urlString, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const apiError = toApiError(res, body);
    logger.error("API form upload failed", {
      url: urlString,
      status: res.status,
      error: apiError.message,
    });
    throw apiError;
  }

  return (await res.json()) as T;
}
