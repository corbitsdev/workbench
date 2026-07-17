# CL-3737 — Insights token-only model visibility

**Linear:** [CL-3737](https://linear.app/abklabs/issue/CL-3737/fix-insights-cost-tab-hiding-token-only-models-kimi-haiku)

## Problem

Production Insights model/cost surfaces showed only deepseek while rollups contain kimi-k2.6 (~51M tokens/30d) and claude-haiku-4-5 with zero turns.

## Root cause

`getAnalyticsModelDistribution` filtered `turn_count > 0`. Token rollups from `inference.done` have real model ids and `turn_count = 0`.

## Requirements

1. Include named models with tokens OR turns; exclude null-model turn-only buckets.
2. Sort by total tokens, then turns.
3. `sumAnalyticsModelTokens` treats missing token columns as zero.
4. Hub activity overview and web InferenceSection use byModel with token fallback for bar height.
5. Export `sumAnalyticsModelTokens` from `@workbench/analytics`; web depends on package.
6. Tests in `packages/analytics/src/queries.test.ts`.
7. Document in `docs/ANALYTICS.md`.

## Non-goals

- Fix empty `metadata.model` on `analytics_event` inference_done rows.
- Add Gemini usage (no prod data in window).

## Verification

```bash
bun run --filter @workbench/analytics test
bun run format && bun run lint && bun run typecheck && bun run test
```
