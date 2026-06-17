# @workbench/context-repair

Repairs malformed agent conversation history before it is sent to an LLM. Strips unsendable assistant turns and re-pairs mismatched tool-call/tool-result blocks.

- `stripUnsendableAssistantTurns` — removes assistant turns that cannot be forwarded (e.g. incomplete tool calls with no matching result)
- `repairToolCallPairing` — re-pairs orphaned tool calls and orphaned tool results
- `healTurns` — composes both repairs into a single pass; call this before sending history to an inference provider

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
