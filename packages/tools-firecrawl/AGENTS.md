# @workbench/tools-firecrawl

Firecrawl tool implementations. Registered in the hub's tool registry as `firecrawl_*`.

- Credential (`firecrawl` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants `tool:firecrawl_*/invoke` are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- Keep the tool schemas in sync with what agents declare in their system prompts
- The Firecrawl base URL is owned by the package (`FIRECRAWL_DEFAULT_BASE_URL`); the credential only needs an API key. Override is possible via `baseURL`.

## Module layout

Each feature area is its own module under `src/`, exporting a `create<Area>Tools(config)` factory plus its `*_DEFINITION` constants. `src/shared.ts` holds the config types, the generic `firecrawlFetchJSON` HTTP helper, and parse/validation utilities. `src/index.ts` aggregates every module into `createFirecrawlTools` and `FIRECRAWL_HUB_TOOLS`.

Long-running job endpoints (crawl, batch-scrape, extract) expose start + status tools rather than blocking; the agent polls.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
