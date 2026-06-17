# @workbench/gtm-workflows

GTM-specific workflow definitions (collateral generation, etc.) registered into the `workflow-core` registry. Each workflow describes its kind, steps, and agent interactions.

- Workflow kinds are registered at hub startup — do not add a kind without registering it
- Agent interactions must go through `@intx/agent`, never direct LLM fetch calls
- New workflows: add a subdirectory under `src/`, export from `index.ts`, register in hub's startup

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
