# CL-3740 — Insights model polish

**Linear:** CL-3740 (follow-up to CL-3737)

## Scope

Low-lift items from CL-3737 dispatch review: whitespace model keys, tenant SQL test, mini-bar comparable scale + unit suffix, cost table regression test, read-only prod audit script, docs.

## Verification

```bash
bun run --filter @workbench/analytics test
bun test apps/web/src/pages/InsightsDashboard.test.tsx apps/web/src/pages/insights/viz.test.tsx
bun run format && bun run lint && bun run typecheck
```
