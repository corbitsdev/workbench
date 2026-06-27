# @workbench/last30days-core

Pure analytics core for the last30days feature. Stateless, side-effect-free
functions — no I/O, no DB, no agent calls. The `last30days-research` workflow and
the `@workbench/tools-last30days` hub tools call into this.

## Pipeline

- `entityExtract` — pull handles/repos/subreddits/hashtags/keywords from a topic.
- `dateFilter` — drop items older than the window (no upper bound, so a
  future-dated item such as a Polymarket market end date stays in-window).
- `dedupe` — collapse duplicate URLs.
- `clusterMerge` — merge items into clusters by URL, shared `entityTag`, or title
  Jaccard ≥ 0.8.
- `rankScore` — score each cluster on relevance (LLM rerank score when present,
  else deterministic entity grounding), freshness (clamped to `[0, 1]`),
  source-quality, an engagement nudge, a source-breadth bonus, and a capped
  top-comment "fun" bonus, minus a degraded penalty. Exposes each cluster's
  `relevance` alongside its `score`.
- `buildReport` — runs the pipeline and returns a typed, ArkType-validated
  `ResearchBrief`: `{ topic, days, queryType?, stats: { sourceCount, itemCount,
dateRange? }, leadInsight?, clusters[], bestTakes[], items[], citations[] }`.
  Its `minRelevance` floor (the workflow brief passes 40) drops off-topic clusters
  before `topK`, so a thin-signal topic returns an honestly-small brief instead of
  padding with noise; it defaults to 0 (off) for existing callers.

`parseReport(unknown)` is the canonical boundary parser consumers use instead of
re-declaring the schema. `schema.ts` owns the ArkType schemas for all input/output
types.

## Rendering

The agent persists a brief via `write_artifact { kind: 'research', data: brief }`,
which stores it at `artifact.source.brief`. `apps/web` `ResearchBody` validates
`source.brief` through `parseReport` and renders clusters, best-takes, stats, and
citations (falling back to markdown when no valid brief is present). Its "Copy
markdown" / "Download .md" actions append a `## Sources` section built from the
brief's citations so the exported file carries its sources, not just the prose.
