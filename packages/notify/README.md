# @corbits/notify

Turns things that need a human — a parked approval, a mention, a failed
run, a credential about to expire, a task result — into mail in the
recipient's mailbox, and fans that mail out to any external sinks
(Slack, email, ...) a principal has turned on. The mailbox row is always
the durable record; a sink delivery is a copy queued strictly after the
mail commits, never the source of truth.

## Composition

- Delivers into a mailbox substrate this package names but does not
  import directly — `mailbox.ts` documents the seam
  (`@corbits/mailbox`'s `deliverInboxItems` shape: same fields, same
  dedupe contract, same post-commit `enqueue` callback) so `@corbits/notify`
  stays free of a hard dependency on any one mailbox build. `@corbits/inbox`
  is the host that wires this package's `./mailbox` types to the real
  `@corbits/mailbox`.
- Sinks plug in through `sinks.ts`'s `NotificationSinkPlugin` contract —
  shaped like `@corbits/commands`' command-plugin contract: named factory
  exports, a registry, one explicit `register(...)` call in the host's
  composition root. No dispatch table, no switch statement.
- `context.ts`'s `resolveNotifyContext` authorizes emit-time (may this
  install push a principal's notification to an external place at all)
  via `@intx/authz` and `@intx/types/authz`; read-time authorization needs
  nothing extra since a mailbox is already scoped to one principal.
- `store.ts` uses `@intx/hub-common`'s `generateId` and Drizzle
  (`drizzle-orm/postgres-js`) against the package-owned `notify` Postgres
  schema (`schema.ts`), fully siloed from the platform's `public` schema.

## Key modules

- `events.ts` — `NotificationEvent` union (approval, mention, run
  failure, credential-expired) parsed at the boundary via arktype.
- `deliver.ts` — `deliverNotification` and per-kind `deliver*Mail`
  helpers: writes the mailbox row, then queues one dispatch row per
  enabled sink.
- `dispatcher.ts` — `createNotifyDispatcher`: the worker that carries a
  due dispatch row out to its sink; finds nothing due until an operator
  registers a sink.
- `approval-bridge.ts` — `createApprovalNotificationBridge`: reads a
  parked approval back (keyed on `approval.id`, also the mailbox dedupe
  key, so a redelivered register frame mails once) and delivers it.
  Registers nothing itself.
- `credential-expiry.ts` — pure decision layer (`findDueCredentialExpiries`)
  for which stored OAuth credentials just crossed their `expiresAt` line;
  touches no database, sends no mail.
- `render.ts` — renders a `NotificationEvent` to subject/body/refs for a
  human reader; identifiers travel only in `refs`, never in display text.
- `migrations.ts` / `schema.ts` — the one product table (`notify_dispatch`):
  one attempt stream per (mail row, sink).

## Tests

```
cd packages/notify && bun test
```

`test/migrations.test.ts` is DB-gated against its own scratch database via
`scripts/e2e/harness.ts`'s `e2eDatabaseUrl` — set
`DATABASE_URL=postgres://localhost:5432/workbench_e2e` or it skips.
