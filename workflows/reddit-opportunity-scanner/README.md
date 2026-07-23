# @workbench/workflow-reddit-opportunity-scanner

The reddit-opportunity-scanner workflow: scan a website, review keyword and
subreddit recommendations, then rank Reddit opportunities for follow-up.

Steps:

1. **intake** — `awaitSignal('intake')`, collect the website URL and optional
   brand, geography, or ICP hints.
2. **scrape** — `deterministicToolStep` calling `firecrawl_scrape` on the URL.
3. **analyze** — `agentStep` that reasons over the scraped content to
   infer what the business sells, its keywords, competitors, and subreddits.
4. **review** — `awaitSignal('recommendation-review')`, a human gate where the
   operator accepts, edits, or removes recommended keywords and subreddits.
5. **scan** — a deployed tool-using `step` agent that searches Reddit
   (`reddit_search` / `reddit_subreddit_search`) for the approved keywords and
   subreddits, then ranks the best opportunities as strict JSON.
6. **selection** — `awaitSignal('opportunity-selection')`, a human gate where
   the operator picks which ranked opportunities to keep.
7. **persist** — `map` over the selected opportunities, one
   `deterministicToolStep` `artifact_create` per item.

`scrape` and `persist` are deterministic tool calls; `analyze` is a pure
single-turn reasoning step (no tools); `scan` genuinely calls the Reddit tools
so it stays a deployed tool-capable agent step.

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
