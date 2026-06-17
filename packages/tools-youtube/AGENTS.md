# @workbench/tools-youtube

YouTube search tool. Registered in the hub's tool registry as `youtube_search`.

- Credential (`youtube` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grant `tool:youtube_search/invoke` is synthesized at session launch from the agent's capabilities list; do not add it to the DB
- Keep the tool schema in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
