# @workbench/agent-scheduler

Starts a recurring timer for agent instances that have `schedulerIntervalMs` set in their capabilities. The scheduler sends a heartbeat message to the sidecar on each tick so the agent can run background tasks.
