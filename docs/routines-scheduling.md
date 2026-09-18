# Routines page data sources

`apps/web/src/routines-api.ts` reads stock deployments (`GET
/workflows/deployments`) joined against the tenant's workflow assets (`GET
/assets?kind=workflow`) for a display name — the two stock reads
`vendor/intx/hub-api/src/routes/workflows.ts` exposes. The old
`@corbits/workflows` scheduled-route and its hub backing are gone.

## Schedule column

The `schedule` trigger is reserved on Interchange but unimplemented — no
scheduler fires it. A schedule shown here is a `@corbits/cron` row addressed
at the deployment's live run, joined in from `GET /cron` by that address
(the same `run_<id>@<domain>` join `chat/threads-api.ts` does against
`listTopLevelRuns`).

## Run-now and pause/resume

Neither has a backing stock route (`/deployments` is list/create only; no
per-deployment PATCH or trigger route exists), so both stay rejected
promises naming the missing route.
