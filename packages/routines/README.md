# @corbits/routines

The Routine domain model: a **routine** is the named, schedulable parent
entity over workflow runs — what a person names, schedules on a cadence
(interval/daily/weekly/cron), and comes back to check on. This package owns
the routine table, trigger validation and cron rendering, dead-lettering of
repeatedly-failing scheduled fires, and the run-correlation link table that
answers "what has this routine done."

## Composition with @intx/*

Built on `@intx/hub-api`'s `TenantEnv`/`requireGrant` route convention and
`@intx/hub-common`/`@intx/log` for IDs and logging. It never talks to
session orchestration directly — launching a run (manual "run now" or a
scheduled fire) goes through `@corbits/folded-runs`, the same launch core
`@corbits/chat`'s invite flow uses. It also depends on
`@corbits/workflow-catalog` to resolve a definition's delivery mode
(channel vs. inbox-only) so a routine's create/fire path never requires a
`deliveryChannelId` a workflow would silently discard.

## Key modules

- `src/routes.ts` — `createRoutineRoutes`: CRUD, run-now, and run-history
  routes, plus `fireScheduledRoutine`, the one scheduled-launch path.
- `src/trigger.ts` — the `RoutineTrigger` arktype schemas (interval, daily,
  weekly, cron), cadence labels, and next-fire computation.
- `src/cron.ts` — cron expression rendering/validation shared by every
  trigger preset.
- `src/store.ts` — `RoutineStore`, the tenant-scoped Drizzle persistence
  layer, including dead-letter bookkeeping.
- `src/client.ts` — the browser-safe subpath: wire schemas and path
  builders only, no `drizzle-orm`/`postgres`/`@intx/hub-api` imports.
- `src/drafts.ts` / `src/myra-drafting.ts` — routine-draft creation and
  Myra-assisted drafting flow.
- `src/migrations.ts` — this package's own `routine_migrations` ledger.

## Scheduling caveat

`fireScheduledRoutine` is exposed but this package ships no scheduler of
its own; the host runs an in-process poller. That poller is single-process
and at-least-once — running more than one hub replica will double-fire
scheduled routines until a host adds leader election or a dedicated
scheduling worker.

## Running tests

```
cd packages/routines && bun test
```

`test/store.drizzle.test.ts` and `test/migrations.test.ts` need a live
Postgres: `DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
