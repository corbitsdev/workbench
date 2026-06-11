# apps/sidecar

Interchange sidecar runtime. Hosts agent instances, runs inference, handles tool calls, and maintains WebSocket connection to the hub.

## Key rules

- This app is mostly Interchange plumbing — keep workbench-specific logic minimal
- Do not add business logic here; it belongs in `apps/hub` or a `packages/*` package
- Agent definitions come from `packages/agents`

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
