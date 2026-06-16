// Browserbase REST client + connectUrl store. The package throws on failure;
// the hub catches and logs at the tool boundary, so nothing is logged here.
//
// The store is a module-level Map, not a closure, because the hub rebuilds the
// tools on every `/tools/run` — a later tool must still find its connectUrl.
import { type } from "arktype";
import {
  CreateSessionResponse,
  SessionStatusResponse,
  SessionSummary,
} from "./schemas";
import type { ResolvedBrowserConfig } from "./types";

const SESSION_CONNECT_URLS = new Map<string, string>();

export function storeSessionConnectURL(
  sessionId: string,
  connectUrl: string,
): void {
  SESSION_CONNECT_URLS.set(sessionId, connectUrl);
}

export function lookupSessionConnectURL(sessionId: string): string {
  const url = SESSION_CONNECT_URLS.get(sessionId);
  if (url === undefined) {
    throw new Error(
      `No connectUrl for browser session "${sessionId}". Call browser_create_session first.`,
    );
  }
  return url;
}

export function removeSessionConnectURL(sessionId: string): void {
  SESSION_CONNECT_URLS.delete(sessionId);
}

// Test-only.
export function clearSessionConnectURLs(): void {
  SESSION_CONNECT_URLS.clear();
}

type Request = {
  method: "GET" | "POST";
  /** Path appended to the base URL, beginning with `/`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) {
    return response.statusText || String(response.status);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === "string") {
        return message;
      }
    }
  } catch {
    return text;
  }
  return text;
}

async function browserbaseFetch(
  config: ResolvedBrowserConfig,
  request: Request,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(`${config.baseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await config.fetcher(url.toString(), {
    method: request.method,
    headers: {
      "X-BB-API-Key": config.apiKey,
      "Content-Type": "application/json",
    },
    signal,
    ...(request.body !== undefined
      ? { body: JSON.stringify(request.body) }
      : {}),
  });
  if (!response.ok) {
    throw new Error(
      `Browserbase API error: ${response.status} ${await errorDetail(response)}`,
    );
  }
  return response.json();
}

export async function createSession(
  config: ResolvedBrowserConfig,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<{ sessionId: string; connectUrl: string }> {
  const data = await browserbaseFetch(
    config,
    {
      method: "POST",
      path: "/sessions",
      body: {
        projectId: config.projectId,
        timeout: timeoutSeconds,
        keepAlive: true,
      },
    },
    signal,
  );
  const session = CreateSessionResponse(data);
  if (session instanceof type.errors) {
    throw new Error(
      `Browserbase create-session response invalid: ${session.summary}`,
    );
  }
  return { sessionId: session.id, connectUrl: session.connectUrl };
}

export async function endSession(
  config: ResolvedBrowserConfig,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  await browserbaseFetch(
    config,
    {
      method: "POST",
      path: `/sessions/${sessionId}`,
      body: { projectId: config.projectId, status: "REQUEST_RELEASE" },
    },
    signal,
  );
}

export type BrowserbaseSession = SessionSummary;

export async function listRunningSessions(
  config: ResolvedBrowserConfig,
  signal: AbortSignal,
): Promise<BrowserbaseSession[]> {
  const data = await browserbaseFetch(
    config,
    { method: "GET", path: "/sessions", query: { status: "RUNNING" } },
    signal,
  );
  if (!Array.isArray(data)) {
    throw new Error("Browserbase session list response is not an array");
  }
  const sessions: BrowserbaseSession[] = [];
  for (const entry of data) {
    const session = SessionSummary(entry);
    if (!(session instanceof type.errors)) {
      sessions.push(session);
    }
  }
  return sessions;
}

// Release any RUNNING session older than maxAgeMs (scheduled backstop beyond the
// create timeout). Unparseable ages are skipped, never force-closed on a guess.
export async function reapStaleSessions(
  config: ResolvedBrowserConfig,
  maxAgeMs: number,
  nowMs: number,
  signal: AbortSignal,
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

const TERMINAL_SESSION_STATUSES = new Set([
  "ERROR",
  "TIMED_OUT",
  "COMPLETED",
  "CANCELLED",
]);

export type WaitForSessionRunningOptions = {
  pollIntervalMs?: number;
  maxWaitMs?: number;
};

const DEFAULT_WAIT_FOR_RUNNING_MAX_MS = 30_000;
const DEFAULT_WAIT_FOR_RUNNING_POLL_MS = 1_000;

// Poll until RUNNING. The browser starts asynchronously after POST /sessions;
// connecting CDP before RUNNING produces a WebSocket timeout.
export async function waitForSessionRunning(
  config: ResolvedBrowserConfig,
  sessionId: string,
  signal: AbortSignal,
  options?: WaitForSessionRunningOptions,
): Promise<void> {
  const pollIntervalMs =
    options?.pollIntervalMs ?? DEFAULT_WAIT_FOR_RUNNING_POLL_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_WAIT_FOR_RUNNING_MAX_MS;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const data = await browserbaseFetch(
      config,
      { method: "GET", path: `/sessions/${sessionId}` },
      signal,
    );
    const session = SessionStatusResponse(data);
    if (session instanceof type.errors) {
      throw new Error(
        `Browserbase session status response invalid: ${session.summary}`,
      );
    }
    if (session.status === "RUNNING") {
      return;
    }
    if (TERMINAL_SESSION_STATUSES.has(session.status)) {
      throw new Error(
        `Browserbase session ${sessionId} reached terminal status: ${session.status}`,
      );
    }
    if (pollIntervalMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  throw new Error(
    `Browserbase session ${sessionId} did not reach RUNNING within ${maxWaitMs}ms`,
  );
}
