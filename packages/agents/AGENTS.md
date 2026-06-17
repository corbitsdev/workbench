# @workbench/agents

Agent definitions: system prompts, credential requirements, tool lists.

When adding a new agent, export its definition from `src/index.ts` and register it in `apps/sidecar`. Do not put business logic or API calls here — definitions only.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
