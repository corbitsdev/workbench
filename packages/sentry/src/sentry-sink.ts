import type { LogRecord, Sink } from "@logtape/logtape";

// The subset of the Sentry client this package depends on. `initSentry()`
// returns the `@sentry/bun` module, which structurally satisfies this.
export interface SentryClient {
  captureException(error: unknown, hint?: unknown): string;
  captureMessage(message: string, hint?: unknown): string;
  flush(timeout?: number): Promise<boolean>;
}

function recordText(record: LogRecord): string {
  if (typeof record.rawMessage === "string") {
    return record.rawMessage;
  }
  return record.message
    .map((part) => (typeof part === "string" ? part : String(part)))
    .join("");
}

/**
 * A LogTape sink that forwards error- and fatal-level records to Sentry. This
 * is the single integration point: any `log.error(..., { error })` anywhere in
 * the app flushes to Sentry, so an error logged at error level can never fail
 * silent. Sub-error levels are ignored. The same pattern is how an OpenTelemetry
 * exporter would later be attached (CL-1923).
 */
export function createSentrySink(client: SentryClient): Sink {
  return (record: LogRecord) => {
    if (record.level !== "error" && record.level !== "fatal") {
      return;
    }

    const text = recordText(record);
    // Sentry's second argument is a CaptureContext passed directly (it inspects
    // top-level level/tags/extra keys); wrapping it in another object makes
    // Sentry treat it as an EventHint and silently drop the context.
    const captureContext = {
      level: record.level === "fatal" ? "fatal" : "error",
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
