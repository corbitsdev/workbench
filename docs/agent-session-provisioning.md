# Agent session provisioning

Notes on `@corbits/workflows`'s `launch/agent-session.ts`.

## Why this module exists

Interchange's `prepareProvisionedDeployment` mints a `sessionId`, but
nothing writes that id into `agent_session` — the table
`resolveRunSessionId` reads to route a run's outbound mail.
`ensureRunSession` does, so mail and spans persist against a real session
from the run's first turn.

## Why the write waits for the run principal

`workflow_run.principal_id` (the FK `agent_session` keys on) is still null
the instant `prepareProvisionedDeployment` returns — a provisioned anchor is
born "deployed" with no principal, and only the run's first trigger
reconciles one onto it. Pre-creating the run's principal to dodge this isn't
an option either: Interchange's own grant materialization inserts the
principal row `onConflictDoNothing` and treats a conflict as "grants already
committed," throwing rather than re-materializing — so nothing upstream of
that first trigger may write the principal first.

`ensureRunSession` is a true upsert, called from every seam that might be a
run's first mail-routable moment: it creates the row once a principal is
anchored, and re-keys an existing row onto it.

The hub also wraps its event collector registry with `withLazyRunCollector`,
so a run's collector exists before its first inference event rather than
after its first outbound mail; otherwise the first reply's parts are dropped.
