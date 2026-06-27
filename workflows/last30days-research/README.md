# @workbench/workflow-last30days-research

The last30days-research workflow: gather the last 30 days of market and community
signal across platforms, synthesize a cited brief, and save it as a `research`
artifact. Inline inference steps use the workflow runtime's `createAgent` path and
do not deploy idling per-step agents.

Steps:

1. **intake** — `awaitSignal('intake')`, collect the topic and an optional focus.
   Intake sends a single `query` string (focus or topic) — no separate normalize
   step.
2. **ground** — `inlineInferenceStep` that turns the topic + focus into one search
   query tailored to each platform (HN/GitHub/web/Reddit/X/YouTube/Polymarket).
3. **groundQueries** — `deterministicToolStep` (`last30days_ground_queries`) that
   parses the grounding reply into a per-source query map (object `content`,
   addressable as `steps.groundQueries.output.content.<source>`). Every key is
   guaranteed a non-empty string, falling back to the base query, so a thin or
   malformed grounding reply never blanks a source.
4. **sources** — one `deterministicToolStep` per source (`hackernews_search`,
   `github_activity`, `exa_search`, `reddit_search`, `x_search`, `youtube_search`,
   `polymarket_odds`), each reading its own tailored query and a per-source
   `limit` sized toward the tool's cap (HN 30, github 25, exa 25, reddit 40, x 20,
   youtube 20, polymarket 25) to deepen the candidate pool.
5. **rerank** — `inlineInferenceStep` relevance judge (W1.2); its JSON reply feeds
   the brief, which applies the scores before ranking.
6. **brief** — `deterministicToolStep` (`last30days_workflow_brief`) that folds the
   source outputs into a `buildReport` brief.
7. **write** — `inlineInferenceStep` that writes the long-form, grounded report
   from the brief.
8. **persist** — `deterministicToolStep` (`write_artifact`) storing the brief +
   prose as a `research` artifact.

### Serial source chain (CL-2314)

The source fetches are chained serially (`groundQueries → hackernews → … →
polymarket`) rather than fanned out. In the sidecar workflow-host topology a
parallel fan-out over rate-limit-prone search APIs races the retry scheduler's
`TimerFired` against a concurrent step's event-log append, tripping the runtime's
single-writer seq guard and failing the run. The serial chain guarantees no body
commit is in flight while a step awaits a retry timer. Revert to fan-out once the
vendored runtime fix coordinates the scheduler with the commit-chain.

Bluesky is disabled (CL-2401): its search API fails on every run; it stays out of
the chain until the auth path is fixed.

### Non-fatal sources (CL-2401)

Each fetch step carries `deterministicToolStep`'s `nonFatal` flag, so a thrown
source error (rate-limit/auth/network) is logged and degraded by the sidecar to a
completed `isError` envelope rather than failing the step — the brief records it in
`skippedSources`. `nonFatal` is for best-effort sources only; `ground`/
`groundQueries`, `brief`, `write`, and `persist` stay fatal.

### Per-step models (CL-2496)

`inlineInferenceStep({ model })` declares a preferred `(LLM_PROVIDER, model)`
source on the step's agent, which the deploy orchestrator's
`pickStepInferenceSource` pins (and the re-drive `buildSupervisorDeployFrame`
mirrors). The grounding and rerank steps ride the deploy default
`LLM_DEFAULT_MODEL` (deepseek-v4-flash); the long-form `write` step prefers
`LLM_WRITER_MODEL` (kimi-k2.6). `resolveWorkflowDeploySource` resolves the
models a definition's steps declare (via `collectDeclaredStepModels`) into
`config.sources` optionally — a step falls back to the default when the tenant
catalog does not carry it, so the deploy never fails on its absence. The per-step
model binds only on the sidecar inline-inference path; the hub-side reasoning
fallback (`createHubReasoningRunner`) always runs on the default model.

## Shape

This is a native `@intx/workflow` package. It exports `kind`
(`'last30days-research'`), `workflow` (a `defineWorkflow(...)`), and a `Panel` UI.
Each step agent declares its tools as serializable `capabilities`, never inline
tool factories — the definition is pushed as JSON.

The deterministic core (`@workbench/last30days-core`) and the tool package
(`@workbench/tools-last30days`) own the pipeline and tools; see their READMEs.

## Deploy

After changing this workflow or its packages, ship to staging:

1. Deploy hub + sidecar images that include the commit (normal release pipeline),
   and republish the tool tarballs if `packages/**` changed.
2. From repo root: `bun run admin:staging` → sign in → select tenant →
   **Workflows** → **Push (deploy)** → `last30days-research`.
3. Start a **new** run in the UI (in-flight runs keep the old definition).

See [../../docs/ADMIN_CLI.md](../../docs/ADMIN_CLI.md) and
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md).
