# @workbench/tools-gamma

Gamma presentation generation tools. Registered in the hub's tool registry as `gamma_*`.

- Credential (`gamma` provider) is resolved via `resolveCredentialRequirement` in the hub tool registry — do NOT add `gamma` to agent `credentialRequirements`
- Direct HTTP to Gamma's REST API is acceptable here (generation SaaS, not an LLM inference provider)
- Gamma's API has no list-templates endpoint; templates are known `gammaId` values managed via `get_gammas` (MCP, OAuth) not the REST API
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
