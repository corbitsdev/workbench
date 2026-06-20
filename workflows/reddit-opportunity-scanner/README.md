# @workbench/workflow-reddit-opportunity-scanner

The reddit-opportunity-scanner workflow: scan a website, review keyword and
subreddit recommendations, then rank Reddit opportunities for follow-up.

Steps:

1. **intake** — collect the website URL and optional brand or ICP hints.
2. **analyze** — scrape the site and infer what the business sells, its
   keywords, competitors, and audience signals.
3. **review** — `awaitSignal('recommendation-review')`, a human gate where the
   operator accepts, rejects, or edits recommended keywords and subreddits.
4. **scan** — search Reddit for the approved keywords and subreddits, then
   score the best opportunities.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'reddit-opportunity-scanner'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`firecrawl_scrape`, `reddit_search`, `reddit_subreddit_search`), never inline
tool factories — the definition is pushed as JSON.

## Deploy

```bash
bun run workflows:push -- --kind reddit-opportunity-scanner
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
