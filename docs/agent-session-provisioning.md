# Agent session provisioning

Notes on `@corbits/workflows`'s `launch/agent-session.ts`.

## Why this module exists

Every Workbench launch path provisions through Interchange's
`prepareProvisionedDeployment` with a `sessionId` it mints itself, but
nothing writes that id into `agent_session` — the table
`resolveRunSessionId` reads to route a run's outbound mail. Every launcher
must do this itself, through this one shared helper, so mail and spans
persist against a real session from the run's first turn.

## Why timing forces a two-step write

`workflow_run.principal_id` (the FK `agent_session` keys on) is still null
the instant `prepareProvisionedDeployment` returns — a provisioned anchor is
born "deployed" with no principal, and only the run's first trigger
reconciles one onto it. Pre-creating the run's principal to dodge this isn't
an option either: Interchange's own grant materialization inserts the
principal row `onConflictDoNothing` and treats a conflict as "grants already
committed," throwing rather than re-materializing — so nothing upstream of
that first trigger may write the principal first.

`recordAgentSessionAtProvision` writes the row immediately after
`prepareProvisionedDeployment` returns, keyed on the deploying principal
since the run principal doesn't exist yet. `ensureRunSession` re-keys onto
the run's own principal once one is anchored, called from every seam that
might be a run's first mail-routable moment, and is a true upsert so a run
deployed straight through Interchange's own deployments route (which skips
the eager write) still gets a row.

## `endAgentSessionFor*`

Called only from places that already know a run died — a chat relaunch or a
one-shot prompt's teardown. No sweeper; a run nobody reacts to stays
`active` until something does.
