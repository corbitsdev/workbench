# @corbits/error-sink

The structured convention every catch block reports a failure to instead of
swallowing it (CL-6496 — the owner ruling this package exists to enforce):
one function, `reportError(error, context)`, that never throws and returns
a `refId` a person can quote to support.

## Why this isn't a second logger

The repo already had one logging concept before this package existed:
`@intx/log` (LogTape underneath), used from `getLogger([...])` /
`log.error(...)` across apps/hub, apps/sidecar, and a dozen packages —
65+ call sites. It already has a pluggable-sink seam (LogTape's own
`configureSync`/sinks) and universal runtime support (Node, Bun,
browsers). `@corbits/client-log`, by contrast, has four call sites, all
in `apps/web`, and exists only because `@intx/log` wasn't adopted there
yet — not because LogTape can't run in a browser.

So this package adds only what `@intx/log` was missing: a fixed
structured-error shape (`operation`, optional `tenantId`/`roomId`/
`agentId`, and a `refId`) plus a redaction pass, delivered through
`getLogger(["errors"])`. Reaching OTEL/Sentry later is a LogTape sink
registered once via `@intx/log`'s own `configureSync`/`setup` — no call
site of `reportError` changes when that happens.

## Retiring `@corbits/client-log`

Out of scope for this unit, but the plan: migrate `apps/web`'s four
`getLogger` call sites (`instant-agent-create.ts`, `auth-screen.tsx`,
`main.tsx`, `app-error-boundary.tsx`) onto `@intx/log` directly, confirm
LogTape's browser sink covers the same "visible in devtools" bar
`client-log`'s console mirror does, then delete `packages/client-log`.
Small enough for one follow-up PR; the only open question is whether
`client-log`'s in-memory ring buffer (for a future devtools panel) has
any real consumer yet, or can be dropped outright.
