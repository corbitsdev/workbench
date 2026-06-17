# @workbench/tools-granola

Granola meeting notes tool implementation. Fetches and exposes meeting transcripts/notes to agents.

- Credential (`granola` provider) is resolved by Interchange at tool execution time
- Tool grant is synthesized at session launch from the agent's capabilities list
- Keep the tool schema in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
