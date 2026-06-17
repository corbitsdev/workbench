# @workbench/tool-template

Scaffold template for new tool packages. Copy this directory to create a new tool integration; do not import directly.

- New tools must be registered in the hub's `tool-registry.ts` to be available to agents
- Tool credentials are resolved at execution time via Interchange — no credential IDs at launch

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
