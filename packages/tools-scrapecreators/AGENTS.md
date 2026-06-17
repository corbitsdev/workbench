# @workbench/tools-scrapecreators

ScrapeCreators web and social scraping tools. Registered in the hub's tool registry as `scrapecreators_*`.

- Credential (`scrapecreators` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
