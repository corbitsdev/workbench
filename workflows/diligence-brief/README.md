# @corbits/diligence-brief-workflow

A single-step, mail-triggered workflow that researches a company and
writes a cited diligence brief as a markdown Library artifact, held for
one human approval (CL-6499, ported from scout's
`workflows/diligence-brief`).

## What ported cleanly

The evidence discipline: ground every claim in a specific tool result,
never invent a founder, funding round, metric, or competitor, and say
"insufficient evidence" plainly rather than padding a thin section. The
research order — firm memory first, then the live web — mirrors scout's
own "tool policy" (artifact refs, then knowledge-search, then web
research), minus the artifact-refs step (this deployment has no
per-brief source-artifact trigger yet). The finalize-then-approve
delivery shape is the same one every other artifact-producing workflow
in this catalog uses (`last-30-days-research`, `pain-point-collateral`,
`collateral-generation`).

## What did not port, and what this rebinds to instead

Scout's tools compile into scout's own sidecar and cannot be pinned here
(`packages/scout/README.md`, CL-5179), so every tool call is rebound to
a workbench-published package:

- Web research -> `@corbits/web-search-tools` (`web_search`, Exa-backed)
- Firm memory -> `@corbits/memory-tools` (`memory_search`)
- Artifact persistence -> `@corbits/artifacts-hub`'s workflow-artifacts
  surface (`createWorkflowArtifact`, via this package's own
  `finalize-tool.ts`/`artifact-client.ts` — duplicated rather than
  imported, same convention every sibling workflow package uses).
  That surface offers create + list-recent only, no search-by-field or
  read-by-id — the same limit the sibling `@corbits/scout-agent` port
  hit — so this workflow only ever writes one artifact per run; it
  never reads a prior brief back by id.

Scout's own artifact-read/knowledge-search tools (reading a founder deck
or prior source document by locator) have no workbench equivalent yet:
this port has no source-artifact input at all, so that gap is moot for
now rather than silently dropped.

## What was trimmed, and why (read before comparing to scout's original)

This is a materially narrower brief than scout's. Be blunt about this
with anyone who has used the original:

- **No per-section parallel steps.** Scout drafts the brief as one
  outline step plus one PARALLEL step per section (team, product,
  revenue, capital, growth, market, risks), each well under a safe
  output-token ceiling, then deterministically assembles them
  (`assemble-brief`). This repo's execution host has never wired the
  `action` primitive that parallel/assembled step graph assumes (the
  same gap `last-30-days-research`'s own header documents). Folding
  seven sections into seven _serial_ reasoning steps would multiply run
  time and per-step timeout risk for a first port, so this port instead
  follows `code-review`'s single-step shape: one agent, one turn,
  everything — research, drafting, all five sections — in one pass.
- **Five sections, not seven.** `DILIGENCE_BRIEF_SECTIONS` folds scout's
  separate Revenue & Business Model / Capital & Runway / Growth &
  Traction sections into one "Traction & Funding" section, and Market &
  Competition into "Product & Market" — a single-turn brief cannot
  sustain three sections' worth of genuinely distinct evidence without
  either padding or fabricating.
- **No scoring.** Scout scores seven weighted dimensions
  (`SCORE_WEIGHTS`, `dims`/`dimensionReads`) and produces a structured
  `DiligenceBrief` object. This port produces prose-only markdown, no
  scores, no structured JSON. Scoring is real product value and cutting
  it is a deliberate scope trim, not an oversight — restoring it is the
  natural next step once the parallel-step machinery above lands here.
- **No source-artifact intake.** Scout's research step opens every
  `sourceArtifactRefs` locator with artifact-read before searching the
  web. This port has no equivalent trigger field, so research starts
  from firm memory and the open web only.

## Verified end to end

`bun test` (package-scoped, stubbing every tool call — no live Exa, no
live inference) passes: the finalize tool persists a stubbed artifact
and returns `persisted: true` on success, returns an honest `isError:
true` naming the failure on a broken persist call rather than a
fabricated success or a silent empty brief, and rejects malformed
arguments without throwing. The definition itself is asserted to name
the exact approval-gated finalize tool, commit to always finalizing
(even on the no-data path), and survive the workflow-asset JSON
round-trip. `bun run typecheck` passes clean.

## Registration

Registered in `packages/workflow-catalog`'s `WORKFLOW_CATALOG` (asset
name `diligence-brief`) alongside this package's own `corbits.workflow`
block, so it shows up wherever that catalog is read: the seed step and
the web Routines picker. See [`workflows/README.md`](../README.md#status-note)
for what registration/automatable/seeded mean — this one is
`automatable: false` (gated behind a human-supplied company name per
run, same as `last-30-days-research`) and not seeded by default.

## Usage

```ts
import {
  buildDiligenceBriefWorkflow,
  serializeDiligenceBriefWorkflow,
} from "@corbits/diligence-brief-workflow";

const definition = buildDiligenceBriefWorkflow({
  triggerAddress: "diligence-brief@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-sonnet-5" }],
  turnTimeoutMs: 600_000,
});

const json = serializeDiligenceBriefWorkflow(definition);
```

Pin `@corbits/web-search-tools` (needs an Exa key, handle `exa`) and
`@corbits/memory-tools` on the deployment for research to reach real
data; without them the brief honestly reports both as unreachable and
finalizes a status-note instead of a real brief.

### Trigger fields (`company`, `focus`)

Every run is triggered by mail to the deployment's address
(`triggerAddress` above); the one reasoning step reads two fields off
the trigger payload:

- `company` (required) — the company the brief is about.
- `focus` (optional) — narrows which angle to dig into (e.g.
  "go-to-market" or "founder track record").
