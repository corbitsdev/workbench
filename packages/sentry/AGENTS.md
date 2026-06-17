# @workbench/sentry

Sentry initialization and error-reporting wrapper. Shared by hub and web so both report to the same DSN with consistent config.

- DSN and environment come from env vars — never hardcode
- Do not add Sentry calls in packages; instrument at the app boundary (`apps/hub`, `apps/web`)

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
