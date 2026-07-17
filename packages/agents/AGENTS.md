# @workbench/agents

Agent definitions: system prompts, credential requirements, tool lists.

When adding a new agent, export its definition from `src/index.ts` and register it in `apps/sidecar`.

This package holds agent **definitions** and the **agent-generic runtime behaviors** that are configured onto every agent's reactor at launch — directors (decision logic), context compactors, and deterministic workflow-step builders. A compactor or a deterministic step legitimately performs the inference/tool call that behavior consists of. What does NOT belong here is product/business logic (HTTP routes, external service integrations, persistence) and per-product rules — those live in `apps/*` or a dedicated `@workbench/*` package.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
