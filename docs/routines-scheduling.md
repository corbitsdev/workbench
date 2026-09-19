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

A schedule whose target has no live deployment left is stopped by the ticker
(`stoppedAt` / `stoppedReason: "deployment_gone"`) and never fires again: a
redeploy does not resume it, so the workbench page renders it as stopped and
offers to schedule it again from a prefilled form.

## Run-now and pause/resume

Neither has a backing stock route (`/deployments` is list/create only; no
per-deployment PATCH or trigger route exists), so both stay rejected
promises naming the missing route.
