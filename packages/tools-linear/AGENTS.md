# @workbench/tools-linear

Read-only Linear API tools. Registered in the hub's tool registry as
`linear_list_issues`, `linear_get_issue`, `linear_list_teams`, and `linear_list_users`.

- Credential (`linear` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants (`tool:linear_*/invoke`) are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- These tools never mutate Linear: queries only
- Keep the tool schema in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
