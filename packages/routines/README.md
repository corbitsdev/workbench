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
  consecutiveFailures: number; // scheduled fires failed in a row; 0 when healthy
  deadLetteredAt: string | null; // set once the scheduler stops firing this routine
}
```

## Delivery destination

`deliveryChannelId` is not always required: a host wires an optional
`deliveryChannelRequired(tenantId, definitionId)` port
(`CreateRoutineRoutesDeps`, also threaded into `fireScheduledRoutine`) that
decides, per definition, whether its result actually posts to a channel at
all. A definition this port says never delivers to a channel (e.g. a
workflow whose result always reaches its creator's Inbox instead) can be
created, run now, and fired on schedule with `deliveryChannelId` entirely
absent — no silent-discard field collected for nothing. Omitting the port
keeps every prior host's contract unchanged: every definition defaults to
channel-required.

## Trigger-input validation

An optional `validateRoutineInput(tenantId, definitionId, input)` port on
`CreateRoutineRoutesDeps` runs at `POST /routines`, rejecting a 400 with an
honest message before a routine is ever created with input that doesn't
match its definition's own declared contract. This is the early, friendly
rejection; a workflow's own launch-time validation remains the
authoritative second line.

## Dead-lettering

`consecutiveFailures` and `deadLetteredAt` track a routine's scheduled-fire
health: each failed scheduled fire increments the counter and backs off the
next attempt; a fire that succeeds (including "run now") clears it. Once
`consecutiveFailures` reaches the package's fire-failure ceiling, the
routine dead-letters — the scheduler stops claiming it until a person
re-enables or edits it — and a synthetic `schedule-failed` run row (with the
launch failure's own `error` text) is recorded so `GET /routines/:id/runs`
shows _why_, not just _that_ it stopped.

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

## `/client` subpath contract

`@corbits/routines/client` (`src/client.ts`) is the browser-safe half of
this package: the wire schemas, tenant-scoped HTTP path builders, and pure
toast copy a UI over routines routes needs, plus a re-export of the
`/trigger` and `/cron` subpaths' cadence/validation surface so a browser
caller has one import for the whole client contract. Kept apart from the
root export so a browser bundle never pulls in `drizzle-orm`, `postgres`,
or `@intx/hub-api` (those stay in `store.ts` / `routes.ts` / `migrations.ts`)
— enforced by `bun run check:browser-safe-subpaths`
(`scripts/checks/browser-safe-subpaths.ts`), which walks this subpath's
transitive import graph, not just by convention.

Read responses use `RoutineTriggerWire`, not the strict `RoutineTrigger`:
a routine's trigger was already validated once, at save time, so a GET
must still parse it even if a cron/timezone check has since tightened.
`RoutineTrigger` stays on `CreateRoutineInput` / `UpdateRoutineInput` /
`CreateDraftInput`, which describe what the client sends.

**Owns:**

- `Routine`, `RoutineRun`, `RoutineDraft`, `DraftedStep` — arktype wire
  schemas (and their inferred types) for every shape `routes.ts` returns.
- `CreateRoutineInput`, `UpdateRoutineInput`, `CreateDraftInput` — request
  body types.
- `routinesPath`, `routinePath`, `routineRunNowPath`, `routineRunsPath`,
  `routineDraftsPath`, `routineDraftPath`, `routineDraftApprovePath`,
  `routineDraftDiscardPath` — the tenant-scoped path builders for every
  route in `routes.ts`.
- `routineCreatedToast`, `routineRunStartedToast` — the confirmation copy
  a create/run-now flow shows.
- `suggestRoutineNameFromPrompt` — a default routine name derived from
  free-form prompt text (first line, truncated), for a create flow that
  starts from a prompt rather than a picked catalog entry — e.g.
  "Make this a routine" on a completed task result, which prefills the
  create dialog with that task's agent, prompt, and this suggested name.
  The person still confirms (or edits) it; nothing here creates a routine
  on its own.
- Re-exported from `./trigger`: `RoutineTrigger`, `RoutineTriggerT`,
  `RoutineTriggerWire`, `RoutineTriggerWireT`,
  `computeNextFireAt`, `cronExpressionForTrigger`, `routineCadenceLabel`,
  `routineCadenceSummary`, `routineMatchesModeFilter`,
  `routineTriggerCategory`, `ROUTINE_WEEKDAY_NAMES`, `timezoneForTrigger`,
  `RoutineModeFilter`; and from `./cron`: `isValidCronExpression`,
  `isValidTimeZone`.

**A host injects:** the actual fetch — its own request function that hits
these paths and validates the response against these schemas (see
`apps/web/src/routines-api.ts`), and `@intx/hub-api`'s own
`/workflows/definitions` listing for the create-flow picker, which is
native to the platform, not this package.

**Never imports:** no `drizzle-orm`, `postgres`, or `@intx/hub-api` — no
Drizzle table, `RoutineStore`, or Hono route reaches this module.

## Install

Like `@corbits/chat`, this package owns its own migrations
(`applyRoutineMigrations`) against a `routine_migrations` ledger table,
independent of the platform's own schema and of any other package's
ledger — extracting this package never has to disentangle its history
from theirs.

## Scheduling

This package exposes `fireScheduledRoutine` but deliberately ships no
scheduler of its own — firing a routine on its cadence is a host
concern. The hub in this repo runs one: an in-process poller that
wakes every 30 seconds, reads every enabled timer-triggered routine
directly (bypassing `RoutineStore`'s tenant scoping, since a scheduler
needs to enumerate across tenants), and fires whichever routine's
cron expression matches the current minute.

That poller is single-process and at-least-once, not a distributed
cron engine. It is correct for exactly one hub replica. Running two or
more hub replicas each with their own poller will double- (or
n-times-) fire a routine's scheduled runs, because nothing coordinates
which replica owns a given tick — a multi-replica deployment needs
leader election or a dedicated scheduling worker before this scales
past one hub process. "Run now" is unaffected by this limit; it always
launches through the same single launch path regardless of replica
count.
