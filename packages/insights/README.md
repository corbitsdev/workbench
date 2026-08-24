# @corbits/insights

Workbench-owned usage sink and tenant insights queries: persists per-turn
token classes from the live inference event stream, exposes
cost/token/activity/run-trace queries. Missing rates and pre-sink history are
explicit absences, never fabricated zeros.

## `/client` subpath contract

`@corbits/insights/client` (`src/client.ts`) is the browser-safe half of
this package — formatting, windowing, and empty defaults any UI over
Insights data can share, kept apart from the server-side collector, store,
and routes so a browser bundle never drags in postgres, drizzle, or hono
(see `client.test.ts`, which asserts no such import reaches this module).

**Owns:** `formatUsd`, `formatCount`, `formatRate`, `durationLabel`,
`tokensLabel`, `usageChromeLabel`, `modelsWithMissingRates` — pure formatting;
`InsightsRange`, `createInsightsWindow`, `activitySeriesForWindow`,
`INSIGHTS_WINDOW_DAYS` — the fixed day-window math every Insights chart
uses; `EMPTY_TOKEN_TOTALS`, `EMPTY_OVERALL_USAGE` — the single empty-state
default so no caller invents its own zero object; and the plain `TokenTotals`
/ `ModelUsage` / `OverallUsage` / `DayActivity` types these operate on.

**A host injects:** nothing — every export here is a pure function or a
constant. A host supplies its own fetch/schema layer (arktype-validated
response parsing, its own route paths) and passes the resulting data
through these helpers; the package has no notion of a hub route or a
tenant.

**Never imports:** no `postgres`, `drizzle-orm`, or `hono` (those stay in
`collector.ts` / `pg-store.ts` / `routes.ts`); no app-specific fetch client
or `apps/web` state — a host's `insights-api.ts` imports from here, never
the reverse.

## Key modules

- `collector.ts` — persists per-turn token classes from the live
  inference event stream into `pg-store.ts`.
- `queries.ts` — cost/token/activity/run-trace queries a hub route
  serves.
- `trace-reader.ts` — reconstructs a single run's trace for the
  run-detail view.
- `pricing.ts` — model rate lookups; a missing rate stays an explicit
  absence, never a fabricated zero.
- `routes.ts` — the tenant-scoped Hono routes wrapping the above.
  `/usage`, `/activity`, and `/tools` roll up the requested tenant's whole
  descendant subtree when a `db` handle is wired (see `resolveScope`) — a
  workbench tenant with no children stays a single-tenant view, and its
  workspace parent aggregates every child workbench, at this query layer
  rather than one browser fetch per workbench. `/scope` is the read-only
  counterpart: a tenant's own identity, its parent (if any), and the
  sibling workbenches to switch between — what a caller reads to build a
  workbench/aggregate switcher.
- `schema.ts` / `migrations.ts` — the usage-sink tables, siloed in their
  own Postgres schema with a package-owned migration ledger.

## Tests

```
cd packages/insights && bun test
```

`test/migrations.test.ts` and the run-trace suites need a real database:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
