# @corbits/routines

A **Routine** is the named parent entity over workflow runs — the
workflow's product face. A run is an occurrence of a routine; the
routine is what a person names, schedules, and comes back to look at.

## Shape

```ts
{
  id: string;
  name: string;
  definitionId: string; // the workflow definition this routine launches
  trigger: RoutineTrigger; // structured schedule, or null for manual-only
  scope: "personal" | "bench";
  input: Record<string, unknown>;
  enabled: boolean;
  deliveryChannelId: string | null; // where results are posted, if anywhere
}
```

## Triggers

A trigger is either `null` (a manual, run-now-only routine) or one of:

- `{ kind: "interval", unit: "minutes" | "hours", every: number }`
- `{ kind: "daily", hour: number, minute: number }`
- `{ kind: "weekly", dayOfWeek: number, hour: number, minute: number }`
- `{ kind: "cron", expression: string }` — a raw 5-field cron escape
  hatch for schedules a preset can't express

Every shape is validated eagerly at the arktype boundary: an
out-of-range preset field or a malformed cron expression is rejected
at save time with a specific error, never discovered later at a missed
fire. `cronExpressionForTrigger` renders any non-null trigger to the
single canonical cron expression a scheduler actually runs against —
the presets are sugar over that one form, never a second schedule
representation.

## Run correlation

Every run a routine launches — scheduled or manual — is recorded in
`routine_run`, a link table keyed by `(tenantId, runId)` pointing at
the routine that launched it. `GET /routines/:id/runs` reads this
table to answer "what has this routine done", optionally enriched with
a run's live status through a host-supplied `RunSummaryResolver`.

"Run now" and a scheduled fire share the same launcher call
(`RoutineLauncher.launchRoutineRun`, `fireScheduledRoutine` in
`src/routes.ts`) — the only difference is the `triggeredBy` value
recorded alongside the run. There is exactly one launch path; a
scheduler is expected to call `fireScheduledRoutine` directly rather
than re-implementing it.

## Routes

Mounted under a tenant prefix, matching the platform's own
`TenantEnv`/`requireGrant` convention:

- `POST /routines` — create
- `GET /routines` — list
- `GET /routines/:id` — get
- `PATCH /routines/:id` — update (name, trigger, input, enabled, delivery channel)
- `DELETE /routines/:id` — delete
- `GET /routines/:id/runs` — run history
- `POST /routines/:id/run` — run now

## Install

Like `@corbits/chat`, this package owns its own migrations
(`applyRoutineMigrations`) against a `routine_migrations` ledger table,
independent of the platform's own schema and of any other package's
ledger — extracting this package never has to disentangle its history
from theirs.
