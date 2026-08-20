// The one browser-side logger (CL-6359): every ad-hoc `console.*` call in
// apps/web and chat-ui routes through this instead, so a user's actions
// are traceable end-to-end through one category+level shape instead of
// scattered, differently-worded console lines. Two jobs: an in-memory
// ring buffer any surface can flush (a devtools panel, a future
// diagnostics beacon), and a console mirror gated by level so a
// production console isn't flooded with routine debug/info trace lines.
//
// This module is the sanctioned exception to the `no-console` lint rule
// (CL-6359) — every other file under `src/` calls `getLogger` instead of
// `console.*` directly.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  readonly at: string;
  readonly category: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: Record<string, unknown>;
};

const RING_BUFFER_SIZE = 500;
const buffer: LogEntry[] = [];

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Only `warn`/`error` mirror to the real console by default — `debug`/
 * `info` stay in the ring buffer only, so a real user's console isn't
 * flooded with routine trace lines. Local dev can lower this. */
let consoleThreshold: LogLevel = "warn";

export function setConsoleThreshold(level: LogLevel): void {
  consoleThreshold = level;
}

function consoleSinkFor(level: LogLevel): (...args: unknown[]) => void {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  return console.log;
}

function record(
  category: string,
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry: LogEntry =
    data === undefined
      ? { at: new Date().toISOString(), category, level, message }
      : { at: new Date().toISOString(), category, level, message, data };
  buffer.push(entry);
  if (buffer.length > RING_BUFFER_SIZE) buffer.shift();
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[consoleThreshold]) {
    consoleSinkFor(level)(`[${category}] ${message}`, data ?? "");
  }
}

export type ClientLogger = {
  readonly debug: (message: string, data?: Record<string, unknown>) => void;
  readonly info: (message: string, data?: Record<string, unknown>) => void;
  readonly warn: (message: string, data?: Record<string, unknown>) => void;
  readonly error: (message: string, data?: Record<string, unknown>) => void;
};

/** A logger scoped to one category — mirrors `@intx/log`'s
 * `getLogger(["a", "b"])` shape closely enough that a category string
 * here reads the same way (dot-joined: `"onboarding.provision"`). */
export function getLogger(category: string): ClientLogger {
  return {
    debug: (message, data) => record(category, "debug", message, data),
    info: (message, data) => record(category, "info", message, data),
    warn: (message, data) => record(category, "warn", message, data),
    error: (message, data) => record(category, "error", message, data),
  };
}

/** Every buffered entry, cleared. */
export function flushLogBuffer(): LogEntry[] {
  const entries = [...buffer];
  buffer.length = 0;
  return entries;
}

/** Every buffered entry, left in place — for a devtools panel that wants
 * to read without consuming. */
export function peekLogBuffer(): readonly LogEntry[] {
  return [...buffer];
}

/** Test-only reset: clears the buffer and the console threshold. */
export function resetClientLogForTests(): void {
  buffer.length = 0;
  consoleThreshold = "warn";
}
