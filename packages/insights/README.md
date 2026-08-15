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
`tokensLabel`, `modelsWithMissingRates` — pure formatting; `InsightsRange`,
`createInsightsWindow`, `activitySeriesForWindow`,
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
