# @workbench/prompts

System prompt builder. Composes tagged `PromptSection` blocks into a final agent system prompt string.

- Each section has a `tag` (used as an XML-like delimiter) and `content`
- Used by agent definitions in `packages/agents` to assemble multi-section prompts
- No side effects — pure string assembly only

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
