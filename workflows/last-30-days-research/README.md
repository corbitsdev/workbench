# @corbits/last-30-days-research-workflow

A multi-step pipeline that researches a topic over the last 30 days
across web search and GitHub and writes it up as one long-form, cited
research report (CL-5879, ported from `gtm-workbench`'s ORIGINAL
`last30days-research` workflow — grounding -> gather -> entity-extract ->
gather -> curate -> write — replacing this repo's prior single-step
scoped-down port, CL-5997).

## What the OG pipeline does

1. **intake** — collect the topic and an optional focus.
2. **ground** — LLM turns the topic + focus into one tailored search
   query per platform.
3. **groundQueries** — parse the grounding reply into a per-source query
   map.
4. **sources (round 1)** — one fetch per platform (nine platforms in the
   OG: three web queries, Hacker News, GitHub, Reddit, X, YouTube,
   Polymarket), chained serially.
5. **entities** — LLM reads round 1's results and names the concrete
   launches/entities worth chasing deeper, writing a follow-up query per
   platform.
6. **entityQueries** — parse the entity reply into a round-2 query map.
7. **sources (round 2)** — four more fetches (web, Reddit, X, YouTube)
   targeting the discovered entities, chained serially.
8. **collect** — deterministically dedupe, date-filter, and drop
   structural junk from the pooled results.
9. **curate** — LLM (heavier writer-tier model) drops promo/off-topic
   items, groups survivors into 3-6 named themes, and pulls verbatim
   community quotes.
10. **brief** — assemble the structured report from curate's output (or a
    deterministic fallback).
11. **write** — LLM (heavier writer-tier model) writes the long-form,
    cited report from the brief.
12. **document** / **persist** — pair title + body and write the
    `research` artifact.

## Adaptations this port makes

**Tool-dispatch shape.** The OG's per-source fetches and its
`groundQueries`/`entityQueries`/`collect`/`brief`/`document`/`persist`
steps were all native `@intx/workflow` `action` primitives, dispatched
through an `ActionInvoker` the OG's execution host wires up. This repo's
host (`apps/sidecar`) has never wired one — `action` is a real primitive
with no host support here, and every existing workflow package in this
catalog calls tools as agent capabilities inside a reasoning turn
instead. This port keeps the OG's step-by-step SHAPE but expresses every
former action step as a plain reasoning step, folding the OG's
deterministic `collect` dedupe/date-filter/junk-drop pass into the
`curate` step's own prompt (see `src/prompts.ts`'s header comment) since
there is no deterministic-step primitive available to carry it on its
own. This is the first genuine multi-step (non-folded) workflow
definition in this catalog — every other package here is single-step by
convention (see `docs/AGENTS-PAGE.md`'s CL-5999 gap). The deploy-time
per-step model resolution this shape assumes (next point) is accordingly
unproven end-to-end here; flagged as an honest gap below.

**Model tiers.** The OG pinned a literal writer-tier model (`kimi-k2.6`
via `openai-compatible`) on `curate`/`write`, leaving `ground`/`entities`
on the deploy default. This catalog's benches carry Ollama (qwen, ...)
and Anthropic, never `openai-compatible`/kimi, so `curate`/`write` here
prepend `WRITER_INFERENCE_PREFERENCE` (`anthropic` / `claude-sonnet-5`)
ahead of the caller's own `inferencePreferences` — the same
"grounding/entity-extraction stay on the deploy default, genuine
editorial judgment and long-form synthesis get the heavier tier" split
the OG's own comment documents, just resolved against this deployment's
catalog instead of the OG's. **Known gap**: this repo's deploy-time model
resolution (`vendor/intx/hub-api/src/run-source-resolution.ts`,
`vendor/intx/workflow-deploy/src/fold-synthesis.ts`) is proven only for
single-step ("folded") definitions, which read a single, definition-wide
model off `steps[0].agent.inference.sources[0]`. Whether a genuine
multi-step definition's per-step `inference.sources` is honored past
step 0 by this repo's deploy pipeline has not been exercised end-to-end;
`WRITER_INFERENCE_PREFERENCE` is the correct definition-level intent
regardless, and this note exists so that gap gets closed deliberately,
not rediscovered.

**Sources.** Same scope as the prior port: `web_search`
(`@corbits/web-search-tools`, Exa-backed — the same provider the OG
used) and `github_activity` (`@corbits/github-tools`, GitHub's public
REST search, keyless-capable). Hacker News, Reddit, X, YouTube, and
Polymarket stay named as "not yet connected" in the gathering steps'
prompt rather than silently dropped (Bluesky was already disabled
upstream for broken auth and is skipped entirely, as before).

**Corbits vocabulary.** Kept verbatim (`src/prompts.ts`'s
`CORBITS_VOCABULARY`) on every reasoning step — the brand-correctness
guidance applies here exactly as it did in the OG.

**Intake.** The OG parks on `awaitSignal("intake")` so a human stepper
can fill topic/focus after the run starts. Workbench collects those
fields on the routine _before_ launch and delivers them as the first-turn
mail. There is no intake gate: `ground` is the first step and every
reasoning step that needs the topic/focus reads `{ from: "trigger.payload" }`.

**Report structure.** This port keeps its own established four-heading
contract (Overview / Key findings / Sources consulted / Citations)
rather than adopting the OG's TL;DR/per-theme-heading structure, since
that contract is what this deployment's delivery and tests already
commit to.

## What of the prior (CL-5997) single-step port is kept vs. replaced

**Replaced**: the single reasoning step and its monolithic system prompt
are gone, split into the six-step pipeline in `src/index.ts`, with
`src/prompts.ts` holding each step's prompt.

**Kept**: `src/finalize-tool.ts` and `src/artifact-client.ts`, unchanged.
The OG's `persist` step dispatched a native `write_artifact` action tool
with no human approval; this repo has no equivalent action-dispatched
tool, and this repo's own ground rule ("every external side effect sits
behind human approval," `AGENTS.md`) means an unapproved persist would be
a policy regression even if one existed. `last_30_days_research_finalize`
(`approval: "ask"`) is this deployment's only proven way to reach the
Library engine from a workflow tool package
(`createWorkflowArtifact`, proven by `pain-point-collateral`/
`collateral-generation`, CL-6000) and is exactly the shape
`packages/chat/src/artifact-delivery.ts` recognizes, so it stays, called
once by the final `write` step.

## Delivery

The `write` step is the pipeline's last step; its own reply (after its
one finalize tool call resolves) is delivered through the run's normal
mail-reply path — the same delivery every other workflow in this catalog
uses, unchanged by this port going multi-step. No separate
"document"/"persist" step is needed for delivery: the writer's own
tool-calling turn is the finalize-and-reply step.

## Current limits (read before deploying)

No tool-package pin yet (CL-5999): every reasoning step ships with
`tools: []`/`capabilities: []`, same as every other workflow in this
catalog, until a production workflow builder can thread
`toolPackagePins` onto a built definition. Without a pin, `web_search`
and `github_activity` are simply absent at runtime and the gathering
steps honestly report both as unreachable.

Multi-step deploy resolution (see "Model tiers" above): this is the
first non-folded, multi-step definition in this catalog. Its per-step
`after` chaining is a generic `@intx/workflow` runtime feature and
should execute correctly; whether the deploy-time model-catalog
resolution honors a step's own `inference.sources` (rather than only the
`stepOrder[0]` step's) has not been proven against this repo's deploy
pipeline and should be verified before a production deploy.

The `topic`/`focus` fields are collected on the routine before launch
(`routine_create` / `routine_update` `input`) and delivered as the
first-turn mail. There is no post-launch intake stepper.

## Usage

```ts
import {
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "@corbits/last-30-days-research-workflow";

const definition = buildLast30DaysResearchWorkflow({
  triggerAddress: "last-30-days-research@tenant.example",
  inferencePreferences: [{ provider: "ollama", model: "qwen-test" }],
  turnTimeoutMs: 300_000,
});

const json = serializeLast30DaysResearchWorkflow(definition);
```

Pin `@corbits/web-search-tools` (needs a `webSearchApiKey`, i.e. an Exa
key) and `@corbits/github-tools` (works keylessly, or with a
`githubApiKey` for a higher rate limit) on the deployment for the
gathering steps to reach real data.

### Trigger fields (`topic`, `focus`)

Every run is triggered by mail to the deployment's address
(`triggerAddress` above); the `ground`/`gather` steps read two fields off
the intake signal payload, matching `@corbits/workflows`'s
`triggerFields` for this workflow exactly:

- `topic` (required) — the free-text subject to research.
- `focus` (optional) — narrows which angle of `topic` to chase across
  every source.

## Registration

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: false`,
gated behind a human-supplied topic per run, and not seeded by default.
