import { setup, getConfig, type SetupOptions } from "@intx/log";
import { configure } from "@logtape/logtape";
import { initSentry } from "./sentry";
import {
  createSentrySink,
  type SentryClient,
  type WarnCategoryPrefix,
} from "./sentry-sink";

let sentryClient: SentryClient | null = null;

// Observability options that are ours, not @intx/log's. Kept off `SetupOptions`
// so the @intx/log `setup()` call never sees a field it does not understand.
export type ObservabilityOptions = {
  // Category subtrees whose `warning`-level records should also flow to Sentry.
  // Supplied per app at the boundary (see setupObservability callers).
  warnCategoryPrefixes?: readonly WarnCategoryPrefix[];
};

type LoggerLike = { category: string | string[]; sinks?: string[] };

/**
 * Add the `sentry` sink to every application logger so error/fatal records flow
 * to Sentry, while keeping LogTape's own `logtape` meta logger off it (a
 * throwing sink logs to meta; routing meta to the sink would risk a feedback
 * loop). App loggers rely on root-logger inheritance, so adding the sink to the
 * configured loggers covers their descendants too. Idempotent.
 */
export function attachSentrySink<T extends LoggerLike>(
  loggers: T[],
): (T & { sinks?: string[]; parentSinks?: "override" })[] {
  return loggers.map((logger) => {
    const category = Array.isArray(logger.category)
      ? logger.category
      : [logger.category];
    if (category[0] === "logtape") {
      return { ...logger, parentSinks: "override" as const };
    }
    const sinks = logger.sinks ? [...logger.sinks] : [];
    if (!sinks.includes("sentry")) {
      sinks.push("sentry");
    }
    return { ...logger, sinks };
  });
}

/**
 * Configure logging and error reporting in one call at application startup.
 *
 * Delegates all console/formatter/level configuration to `@intx/log`'s
 * `setup()` (no duplication), then layers a Sentry sink onto the existing
 * loggers so error/fatal records also flush to Sentry. When `SENTRY_DSN` is
 * unset, `initSentry()` returns null and this leaves the console-only config
 * untouched, so local/dev is unaffected.
 *
 * Replaces calling `initSentry()` and `@intx/log` `setup()` separately.
 */
export async function setupObservability(
  options: SetupOptions = {},
  observability: ObservabilityOptions = {},
): Promise<void> {
  sentryClient = await initSentry();

  await setup(options);
  if (!sentryClient) {
    return;
  }

  const current = getConfig();
  if (!current) {
    return;
  }

  const sentrySink = createSentrySink(
    sentryClient,
    observability.warnCategoryPrefixes,
  );
  await configure({
    reset: true,
    sinks: { ...current.sinks, sentry: sentrySink },
    loggers: attachSentrySink(current.loggers),
  });
}

/**
 * Flush buffered Sentry events. Call before a deliberate process exit (e.g. in
 * the uncaughtException handler) so the captured event is not lost. No-op when
 * Sentry is not initialized.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (sentryClient) {
    await sentryClient.flush(timeoutMs);
  }
}
