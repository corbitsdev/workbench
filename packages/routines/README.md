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
(workbench vs. inbox-only) so a routine's create/fire path never requires a
`deliveryWorkbenchId` a workflow would silently discard.

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

## Routine targets follow the latest deployed asset

A routine stores `definitionAssetId`, not a pinned `workflow_definition`
row: the workflow asset it follows across redeploys, never a snapshot of
one version of it. `src/target.ts`'s `resolveLaunchableDefinition` is the
one place that asset resolves to the definition that actually runs — the
newest `workflow_definition` for that asset, in the caller's tenant, that
is both `deployed` and frozen (has an approved wire hash, grant snapshot,
and wire projection). Every caller that needs "the definition this routine
runs right now" — create/retarget validation, a read's `definitionId`
field, and a fire (`fireScheduledRoutine` or "run now") — resolves through
this one function rather than trusting anything pinned at creation, so a
routine automatically follows its asset's latest approved deployment. A
target that does not currently resolve (not found, cross-tenant, not
deployed, or not yet approved) reports `definitionId: null` on read and
fails a fire closed, via `RoutineTargetUnresolvableError` /
`routineTargetRejection`, rather than launching a stale or wrong
definition.

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

## Routine target discovery

`GET /api/tenants/:tenantId/workflows/targets` (`src/targets-route.ts`,
mounted by the hub beside the platform's `/workflows/definitions` listing)
is the one list every routine-authoring surface reads: the deployed,
frozen definitions the acting principal may target from a routine in this
tenant (CL-7351). Agents and multi-step workflows share it — a target's
`kind` (`"agent"` for a single-step conversational fold, `"workflow"`
otherwise) only groups the picker.

- `listLaunchableDefinitions(db, tenantId)` (`src/targets.ts`) is the
  follow-latest rule from `docs/workflow-model.md` as one query: the newest
  `authored` `workflow_definition` row per `asset_id` with
  `status = 'deployed'` whose current version row carries a non-null
  `approved_wire_hash`, `grant_snapshot`, and `wire_projection`. Source-only,
  unfrozen, stopped, per-run (`origin = 'run'`), and cross-tenant rows never
  qualify. The routine launch resolver reads the same rows for one asset.
- `listRoutineTargets(deps, query)` authorizes every candidate with
  `@intx/authz`'s `authorize` on `workflow-definition:<id>` / `read` before
  it is counted, sorted, or returned — a denied row never shapes the page —
  then applies the product filter (`@corbits/workflow-catalog`'s
  `isAutomatableWorkflowName` or `isConversationalWorkflowName`, never a
  workbench-host anchor name) and orders by `(name asc, definitionAssetId
  asc)`. Pagination is an opaque cursor over that key; `limit` defaults to
  50 and caps at 200. A principal holding no definition grant gets an empty
  page, not a 403.
- Wire shape (`@corbits/routines/client`): `RoutineTarget`
  `{ definitionAssetId, definitionId, assetName, name, description, kind,
  wireHash }`, `RoutineTargetsResponse` `{ items, nextCursor }`, and
  `routineTargetsPath(tenantId, { limit?, cursor? })`.
  `definitionAssetId` is the identity a routine stores; `definitionId` /
  `wireHash` name what would run right now.

`test/targets.drizzle.test.ts` covers tenant isolation, unfrozen and
per-run exclusion, newest-per-asset, agent vs. workflow kind, a principal
without the grant, the empty tenant, and cursor continuation. It needs the
same live Postgres as the other Drizzle suites.
