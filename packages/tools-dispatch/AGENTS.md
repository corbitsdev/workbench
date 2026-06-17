# @workbench/tools-dispatch

Agent dispatch tool. Registered in the hub's tool registry as `dispatch_agent`.

- A context tool (no external credential): uses `SessionService`, `EventCollectorRegistry`, and `SidecarRouter` from the hub context
- Spawns a new agent instance from an existing definition, persists the instance/session, and sends the initial task message
- Must be wired with full session context (`sessionService`, `eventCollectors`, `sidecarRouter`, `buildToolDefinitions`) — throws at tool call time if any are missing
- `eventCollectors.create()` is called inside the tool after launch; the hub does not need to call it again

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
