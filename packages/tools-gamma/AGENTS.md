# @workbench/tools-gamma

Gamma presentation generation tools. Registered in the hub's tool registry as `gamma_*`.

- Credential (`gamma` provider) is resolved via `resolveCredentialRequirement` in the hub tool registry — do NOT add `gamma` to agent `credentialRequirements`
- Direct HTTP to Gamma's REST API is acceptable here (generation SaaS, not an LLM inference provider)
- Gamma's REST API has no list-templates endpoint; workbench templates are a DB-backed resource (`workbench_template`, config `{ gammaId, description }`) managed over the hub REST API (`GET/POST/PUT/DELETE /api/v1/gamma-templates`, `POST .../:id/delegates`), with grant-based ownership. The agent lists them via the `gamma_list_templates` ContextToolEntry; the web uses the REST route
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
