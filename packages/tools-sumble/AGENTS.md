# @workbench/tools-sumble

Sumble v8 API tools (organizations, teams, people, jobs, signals, intelligence
briefs). Registered in the hub's tool registry as eight `sumble_*` read tools.

- Credential (`sumble` provider) is resolved by Interchange at tool execution
  time — not at agent launch
- The tool grants `tool:sumble_*/invoke` are synthesized at session launch from
  the agent's capabilities list; do not add them to the DB
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
