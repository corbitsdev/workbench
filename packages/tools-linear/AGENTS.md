# @workbench/tools-linear

Linear API tools. Registered in the hub's tool registry as `linear_list_issues`,
`linear_get_issue`, `linear_list_teams`, `linear_list_users` (read-only) and
`linear_create_issue` (one approval-gated write).

- Credential (`linear` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants (`tool:linear_*/invoke`) are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- The read tools never mutate Linear: queries only
- `linear_create_issue` is the only write. It is classified `sideEffect: "write"`, so the hub routes it through the human ReviewGate before it runs (its LLM-safe name `linear__create_issue` lives in `APPROVAL_GATED_TOOL_NAMES`) — there is no custom gate, grant, or Owner toggle
- Keep the tool schema in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
