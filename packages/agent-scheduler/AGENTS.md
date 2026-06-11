# @workbench/agent-scheduler

Recurring scheduler for agents with `schedulerIntervalMs` in their capabilities. Called from `apps/hub` after a successful session launch.

No product logic lives here — it only manages timers and sends heartbeat events to the sidecar.

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
