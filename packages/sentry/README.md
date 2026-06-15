# @workbench/sentry

Error reporting and observability wiring for the hub and sidecar.

## Usage

Call once at application startup, replacing separate `initSentry()` + `@intx/log` `setup()` calls:

```ts
import { setupObservability } from '@workbench/sentry';

await setupObservability({ dev: process.env.NODE_ENV !== 'production' });
```

## How it works

- `setupObservability()` delegates all console/formatter/level configuration to `@intx/log`'s `setup()` (no duplication), then attaches a **LogTape Sentry sink** to the existing loggers.
- The sink forwards every `log.error` / `log.fatal` record to Sentry — `captureException` when the record carries an `error` property, otherwise `captureMessage`. Sub-error levels are ignored, and LogTape's own `logtape` meta logger is kept off Sentry. This means an error logged at error level anywhere in the app cannot fail silent.
- When `SENTRY_DSN` is unset, `initSentry()` returns `null` and the sink is a no-op, so local/dev is unaffected.

## Env

- `SENTRY_DSN` — enables Sentry when set (also mirrored in `apps/hub/src/config.ts` for visibility).
- `SENTRY_ENVIRONMENT` — defaults to `production`.

## Boundaries

`flushSentry(timeoutMs?)` drains buffered events before a deliberate process exit (e.g. in an `uncaughtException` handler).

## Extending to OpenTelemetry

Adding OTel later is the same pattern: build an exporter sink and add it to the LogTape `loggers` config in `setup.ts` alongside `sentry`. No call-site changes are needed because everything already flows through structured `@intx/log` records.
