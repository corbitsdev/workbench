# @workbench/event-collector

Per-session collector that persists assistant inference turns from the InferenceEvent stream to the DB. One collector per active session; events are written eagerly so data survives crashes.

- `EventCollectorRegistry` manages the per-address collector map; create a collector via `registry.create(address, tenantId, sessionId, instanceId)` immediately after `sessionService.launchSession()`
- The collector logic is a faithful copy of `@intx/hub-sessions` lifted into the workbench so the registry can serialize events per agent — keep it equivalent to upstream
- Do not call `eventCollectors.create()` after any await that could race with the first inference event

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
