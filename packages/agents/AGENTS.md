# @workbench/agents

Agent definitions: system prompts, credential requirements, tool lists.

When adding a new agent, export its definition from `src/index.ts` and register it in `apps/sidecar`. Do not put business logic or API calls here — definitions only.

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
