# @workbench/tools-reddit

Reddit search tools via ScrapeCreators. Registered in the hub's tool registry as `reddit_*`.

- Credential (`scrapecreators` provider) is resolved by Interchange at tool execution time — not at agent launch
- Reddit tools use the ScrapeCreators credential (not a Reddit-native credential); do not add a separate `reddit` provider
- The tool grants are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
