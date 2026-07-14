# @workbench/tools-linear

Linear GraphQL tools for hub agents. The registry is `LINEAR_HUB_TOOLS` in
`src/hub-tools.ts` (**42** tools: **26** read, **16** write). Full catalog:
[docs/LINEAR_TOOLS.md](../../docs/LINEAR_TOOLS.md).

- Credential (`linear` provider) is resolved by Interchange at tool execution time — not at agent launch
- Tool grants (`tool:linear_*/invoke`) are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- Read tools use GraphQL queries only; write tools set `sideEffect: "write"` on hub entries for ReviewGate / grant `ask` in interactive sessions
- Keep agent prompts aligned with the tools the agent actually declares

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards. Package tests:
`bun test --isolate` from this directory.