# @corbits/webhook-triggers

Webhook-triggered workflow launches: an external service (e.g. Granola)
posts a payload to a per-trigger URL, the payload is verified against an
HMAC signature and mapped through a stored `{{path.to.field}}` template
into a workflow's input, and the resulting run launches through the same
folded-run path chat's invite flow uses.

## Composition with @intx/*

Launching never talks to `sessionService`/`sidecarRouter` directly — only
through `@corbits/folded-runs`' `launchFoldedRun` and
`sendFoldedMailWithRetry`, the same shared launch core
`apps/hub/src/routine-launcher.ts` and `@corbits/chat`'s invite flow use.
Routes are built on `@intx/hub-api`'s `TenantEnv`/`requireGrant` and
`@intx/hub-sessions`; `@intx/db` provides the platform drizzle handle and
schema (`tenant`, `workflowDefinition`); `@intx/hub-common` generates ids;
`@intx/log` logs. The signing secret is encrypted at rest through
Interchange's `CredentialCipher` seam (`@intx/types`, dev dependency
`@intx/crypto` for tests).

## Key modules

- `src/schema.ts` — the one product table, `webhook_trigger`, in its own
  `webhook_triggers` Postgres schema; the signing secret is stored
  encrypted.
- `src/signature.ts` — `generateWebhookSecret`/`signPayload`/`verifySignature`:
  the HMAC-SHA256 trust boundary an inbound delivery must pass before
  anything else runs.
- `src/mapping.ts` — `renderInputTemplate`: fills a trigger's stored
  template against the parsed payload; a missing field degrades to an
  empty string rather than rejecting the delivery.
- `src/launch.ts` — `launchWebhookTrigger`: launches the run and hardens
  the opening-mail send so a delivery already accepted (202) never throws
  and never double-fires on a sender's retry.
- `src/ingress-routes.ts` — `createWebhookIngressRoutes`: the public,
  unauthenticated delivery endpoint a webhook sender posts to.
- `src/management-routes.ts` — `createWebhookTriggerRoutes`: tenant-session
  CRUD for creating/rotating/listing triggers.
- `src/migrations.ts` — this package's own `webhook_triggers_migrations`
  ledger.

## Running tests

```
cd packages/webhook-triggers && bun test
```

`test/store.drizzle.test.ts` and `test/migrations.test.ts` need a live
Postgres: `DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
