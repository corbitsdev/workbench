# @workbench/tools-agents

Agent directory tool. Registered in the hub's tool registry as `list_agents`.

- A context tool (no provider credential): it reads the tenant's `agentInstance` rows (joined with `agent` for the name) directly from the Interchange db
- Returns each agent's name, mail address, status, definition id, and instance id so a caller can address it with `mail_send`
- The tool grant `tool:list_agents/invoke` is synthesized at session launch from the agent's capabilities list; do not add it to the DB

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
