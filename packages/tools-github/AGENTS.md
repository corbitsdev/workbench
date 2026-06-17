# @workbench/tools-github

GitHub activity tool. Registered in the hub's tool registry as `github_activity`.

- Credential (`github` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grant `tool:github_activity/invoke` is synthesized at session launch from the agent's capabilities list; do not add it to the DB
- Keep the tool schema in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
