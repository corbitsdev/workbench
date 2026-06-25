import type { LogRecord, Sink } from "@logtape/logtape";

// The subset of the Sentry client this package depends on. `initSentry()`
// returns the `@sentry/bun` module, which structurally satisfies this.
export interface SentryClient {
  captureException(error: unknown, hint?: unknown): string;
  captureMessage(message: string, hint?: unknown): string;
  flush(timeout?: number): Promise<boolean>;
}

// Map a LogTape level to the Sentry severity it should report as. Only the
// levels the sink forwards are represented; anything else falls back to
// "error" so a forwarded record can never carry an unexpected severity.
function levelFor(level: LogRecord["level"]): "fatal" | "warning" | "error" {
  if (level === "fatal") return "fatal";
  if (level === "warning") return "warning";
  return "error";
}

function recordText(record: LogRecord): string {
  if (typeof record.rawMessage === "string") {
    return record.rawMessage;
  }
  return record.message
    .map((part) => (typeof part === "string" ? part : String(part)))
    .join("");
}

// A category prefix the caller wants warning-level records forwarded for. A
// record matches when its `category` array starts with this exact prefix, so
// `["workflow-host"]` matches `["workflow-host","supervisor"]`. The app
// boundary supplies the allowlist; the package never decides which categories
// are interesting (see packages/sentry AGENTS.md — instrument at the app edge).
export type WarnCategoryPrefix = readonly string[];

function categoryHasPrefix(
  category: readonly string[],
  prefix: WarnCategoryPrefix,
): boolean {
  if (prefix.length > category.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (category[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * A LogTape sink that forwards error- and fatal-level records to Sentry. This
 * is the single integration point: any `log.error(..., { error })` anywhere in
 * the app flushes to Sentry, so an error logged at error level can never fail
 * silent.
 *
 * `warnCategoryPrefixes` opts specific category subtrees into *warning*-level
 * forwarding too. The workflow-run failure path (supervisor replay, run-pack
 * push) logs at `warning`, not `error` — without this it stays invisible to
 * Sentry, which is how a wedged staging plane paged no one. The
 * allowlist is narrow on purpose: it must not include high-churn transient
 * categories (e.g. WS reconnect) or it floods Sentry. Other sub-error levels
 * are ignored. The same pattern is how an OpenTelemetry exporter would later be
 * attached (CL-1923).
 */
export function createSentrySink(
  client: SentryClient,
  warnCategoryPrefixes: readonly WarnCategoryPrefix[] = [],
): Sink {
  return (record: LogRecord) => {
    const isError = record.level === "error" || record.level === "fatal";
    const isAllowedWarning =
      record.level === "warning" &&
      warnCategoryPrefixes.some((prefix) =>
        categoryHasPrefix(record.category, prefix),
      );
    if (!isError && !isAllowedWarning) {
      return;
    }

    const text = recordText(record);
    // Sentry's second argument is a CaptureContext passed directly (it inspects
    // top-level level/tags/extra keys); wrapping it in another object makes
    // Sentry treat it as an EventHint and silently drop the context.
    const captureContext = {
      level: levelFor(record.level),
      tags: { logCategory: record.category.join(".") },
      extra: { ...record.properties, logMessage: text },
    };

    const errorValue = record.properties.error;
    if (errorValue instanceof Error) {
      client.captureException(errorValue, captureContext);
      return;
    }
    client.captureMessage(text, captureContext);
  };
}
