# @corbits/longevity-sim

Longevity simulation harness (CL-6440): drives a real workbench stack
(hub + sidecar + Postgres) through time-compressed team life — ~10
simulated sales humans, agents, and routines. The humans are scripted
(deterministic posts, replies, mentions), but every agent turn is real
inference against the owner's Ollama fleet, spread across multiple
models and base URLs — there is no stub or noop inference path.
Checkpoints track degradation metrics and self-improvement checks as
the campaign runs.

## This package's slice: the pure core

Everything under `src/` here is pure and deterministic given a `seed` —
no network, no process spawning, no filesystem access. It owns:

- `prng.ts` — seeded RNG (`createRng`, `pick`).
- `personas.ts` — the fictional 10-person sales team and their
  deterministic chatter (`SALES_TEAM`, `utterance`).
- `config.ts` — `CampaignConfig`, arktype-validated
  (`campaignConfig`, `parseCampaignConfig`).
- `plan.ts` — turns a `CampaignConfig` into an ordered `PlanStep[]`
  (`buildPlan`, `summarizePlan`).
- `metrics.ts` — percentile math and knee detection over
  `CheckpointRecord`s (`percentile`, `findKnees`).
- `report.ts` — renders a `CampaignReport` to markdown
  (`renderCampaignReport`, `reportVerdict`).

A separate stack layer (`stack.ts`, `engine.ts`, `probes.ts`, `cli.ts`)
drives the actual HTTP stack and boot glue against this plan; it is out
of scope for this slice and not exported from `src/index.ts` yet.

## Scripts

- `bun run typecheck`
- `bun test`
