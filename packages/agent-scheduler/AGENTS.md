# @workbench/agent-scheduler

Recurring scheduler for agents with `schedulerIntervalMs` in their capabilities. Called from `apps/hub` after a successful session launch.

No product logic lives here — it only manages timers and sends heartbeat events to the sidecar.
