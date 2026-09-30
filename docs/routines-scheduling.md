# Routines page data sources

`apps/web/src/routines-api.ts` reads stock deployments (`GET
/workflows/deployments`) joined against the tenant's workflow assets (`GET
/assets?kind=workflow`) for a display name — the two stock reads
`vendor/intx/hub-api/src/routes/workflows.ts` exposes. The old
`@corbits/workflows` scheduled-route and its hub backing are gone.

## Schedule column

The `schedule` trigger is reserved on Interchange but unimplemented — no
scheduler fires it. A schedule shown here is a `@corbits/cron` row targeting
an agent by its workflow definition's name — the source asset's name, stable
across redeploys — joined in from `GET /cron` by that name. The ticker
resolves the name to the live anchor run at fire time, so a redeploy keeps
the schedule working.

An agent between runs has no live anchor to deliver to, so the ticker skips
the tick and marks the row waiting (`waitingSince`) instead of firing. The
next delivery clears the marker, so a restart or a redeploy resumes the
schedule on its own; the workbench page shows such a row as waiting for its
agent, at full weight.

Only a schedule whose agent's definition is gone is stopped by the ticker
(`stoppedAt` / `stoppedReason: "agent_deleted"`), and it never fires again:
a redeploy does not resume it, so the workbench page renders it as stopped
and offers to schedule it again from a prefilled form. Creating a schedule
for a name no definition carries is rejected the same way
(`400 unknown_definition`).

## Run-now and pause/resume

Run now posts to the stock trigger route
(`POST /workflows/:runId/mail`, `:runId` = the deployment id), carrying the
cron row's subject and body when one exists. A 409 means the run has ended.
Pause/resume has no stock or `@corbits/cron` primitive, so no control is
shown.
