# @workbench/hub

Composition root that mounts the platform API, extension routes, and the
user interface on one origin. Apps stay generic — every product rule
belongs in a package (see [AGENTS.md](../../AGENTS.md)) — so this app's
job is wiring, not deciding: config, then database, then auth, then the
platform app, in the platform's own idiom, following Interchange's
native tenant middleware.

## What it wires

- Interchange's `@intx/hub-api` (`createApp`) and `@intx/hub-sessions`
  provide the platform's own routes, auth, and tenant middleware; this
  app never re-implements them.
- Every `@corbits/*` and `@workbench/*` package route (chat, approvals,
  bench, insights, access-policy, mailbox, memory, skills, artifacts,
  routines, tasks, webhooks, Slack tag, and more) mounts here as one
  explicit import plus one `app.route(...)` call, inside or outside the
  tenant prefix as the extension requires. `src/index.ts` is the single
  file where all of this comes together.
- There are no local `src/*-mount.ts` wiring helpers: each extension's
  routes mount directly in `src/index.ts` with the shared DB
  handle/config passed inline at the `app.route(...)` call site.
- Serves the built `apps/web` SPA from its own origin
  (`HUB_STATIC_DIR` points at `apps/web/dist`), so every `/api` call the
  interface makes is same-origin.
- `credential-expiry-sweep.ts`, `workflow-scheduler.ts`, and
  `inbox-unsnooze-sweep.ts` are host-level periodic sweeps wired at boot,
  alongside the route mounts; `cron-due.ts` is a re-export seam onto
  `@corbits/workflows`' own cron matcher, not a second implementation.
  Tenancy is the stock platform's own middleware — there is no local
  tenant-create guard.
- `in-flight-requests.ts` and `shutdown.ts` bound SIGINT/SIGTERM: the hub
  waits for Hono handlers that have not yet returned a Response (a
  request still in a Postgres transaction, a git write), then
  `server.stop(true)` so a live SSE bridge or sidecar websocket cannot
  hang the drain. The sequence is capped at 10s; a lingering stream is
  not a shutdown fault.

## Running

```
bun run dev   # apps/hub/package.json, loads ../../.env
bun run start
```

## Tests

```
cd apps/hub && bun test
```

Suites under `test/` exercise composition and wiring; the DB-backed
ones run against a real database:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
