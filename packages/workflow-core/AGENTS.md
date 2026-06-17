# @workbench/workflow-core

Workflow type system and registry. Defines `WorkflowType` and `WorkflowTypeRegistry`; GTM-specific workflows register themselves here at hub startup.

- `workflowRegistry` is the singleton — import it to register or look up workflow kinds
- New workflow kinds: define in `@workbench/gtm-workflows`, register at hub startup
- No UI or agent logic here — purely type definitions and the registry

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
