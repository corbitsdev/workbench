import { getLogger } from '@intx/log';

const log = getLogger(['sentry']);

export async function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  const environment = process.env.SENTRY_ENVIRONMENT;

  if (!dsn) {
    return null;
  }

  try {
    const sentry = await import('@sentry/bun');
    sentry.init({
      dsn,
      environment,
      tracesSampleRate: 0.0,
    });
    return sentry;
  } catch (error) {
    log.warn('Failed to initialize Sentry', { error });
    return null;
  }
}
