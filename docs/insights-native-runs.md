# Insights: native runs feed cutover

`apps/web/src/insights-api.ts` reads the native tenant-scoped `GET
/workflows/runs` listing. The old `@corbits/run-scope` and `packages/insights`
are deleted; the hub mounts nothing Workbench-specific anymore. The four
stock observability routes are unimplemented 501 stubs, so usage/cost,
tool-call, latency, run-trace and cross-workbench scope lost their only data
source and were dropped rather than faked.

Differences from the deleted `feed=fires` feed, all accepted loss:

- A routine's fire (not a top-level run) is no longer included.
- No routine attribution, so history groups by definition instead.
- The resident, never-triggered deployment placeholder is now included and
  counted as deployed by `computeInsightsStats`.
- The feed is single-tenant: the deleted route rolled up a workspace
  parent's whole descendant subtree; the native listing filters one tenant.

This replaces the dead `/me/workflows/runs`, whose `anchorRunId IS NULL`
filter never matched anything (every addressed run self-anchors at
creation), so that feed always came back empty.

`InsightsRunSchema` adds `routineId`/`routineName` (absent on the native
feed; callers fall back to `definitionId`/`definitionName`) and
`turns`/`hasInFlightTurn`, this build's own in-flight-turn tracking, not an
Interchange field — omitting them is not "no in-flight turn".
