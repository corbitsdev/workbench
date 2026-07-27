# @workbench/workflow-reddit-opportunity-scanner

The reddit-opportunity-scanner workflow: scan a website, review keyword and
subreddit recommendations, then rank Reddit opportunities for follow-up.

Steps:

1. **intake** — `awaitSignal('intake')`, collect the website URL and optional
   brand, geography, or ICP hints.
2. **scrape** — native `action` calling `firecrawl_scrape` on the URL.
3. **analyze** — `agentStep` that reasons over the scraped content to
   infer what the business sells, its keywords, competitors, and subreddits.
4. **review** — `awaitSignal('recommendation-review')`, a human gate where the
   operator accepts, edits, or removes recommended keywords and subreddits.
5. **collect** — native `action` dispatching a workflow-owned batch tool
   (`collect-tool.ts`) that searches Reddit (`reddit_subreddit_search`) for
   every approved search, tolerating a per-search failure inside its result
   envelope instead of failing the run.
6. **curate** — `agentStep` that judges the collected Reddit evidence and
   ranks the best opportunities as strict JSON.
7. **selection** — `awaitSignal('opportunity-selection')`, a human gate where
   the operator picks which ranked opportunities to keep.
8. **persist** — native `action` dispatching a workflow-owned batch tool
   (`persist-tool.ts`) that saves every selected opportunity as an artifact,
   failing the run on the first failed save.

`scrape`, `collect`, and `persist` are native `action`s dispatching workflow-
owned tools; `analyze` and `curate` are pure single-turn reasoning steps (no
tools).

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'reddit-opportunity-scanner'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`firecrawl_scrape`, `reddit_search`, `reddit_subreddit_search`), never inline
tool factories — the definition is pushed as JSON.

## Deploy

Push via the admin CLI (`bun run admin` → select a tenant → "Local actions →
Push a workflow"). At the "Workflow kind" prompt, type just the kind value:
`reddit-opportunity-scanner`.

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/ADMIN_CLI.md](../../docs/ADMIN_CLI.md) for the operator entrypoint,
and [../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
