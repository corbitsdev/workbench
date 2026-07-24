# @workbench/tools-corbits-knowledge-engine

Tools that call the standalone Corbits knowledge engine over HTTP. Registered
in the hub's tool registry as `search_company_knowledge` and
`capture_to_knowledge`.

- Credential (`corbits-knowledge-engine` provider) is resolved by Interchange
  at tool execution time — not at agent launch. The secret is a service
  token; the engine's base URL rides on the credential's `baseURL` (the
  provider's `metadata.baseURL`), exactly like Firecrawl/Granola/Linear.
- Unlike a plain credentialed tool package, these two tools also need the
  calling agent's `tenantId`/`principalId` — resolved from the sidecar's
  hub-RPC context, never from agent-supplied arguments, so an agent cannot
  search or write into another tenant's knowledge base. `interchange-tools.ts`
  therefore declares BOTH `toolCredentialEnvKey("corbits-knowledge-engine")`
  and `HUB_RPC_ENV_KEY` in `requires` and merges the two into one config,
  rather than using the shared `defineCredentialedToolPackage` helper
  verbatim. See its file header for why.
- The tool grants `tool:search_company_knowledge/invoke` and
  `tool:capture_to_knowledge/invoke` are synthesized at session launch from
  the agent's capabilities list; do not add them to the DB.

## Module layout

`src/shared.ts` holds the config type, the `knowledgeEngineFetchJSON` HTTP
helper, and parse/validation utilities (mirrors
`packages/tools-firecrawl/src/shared.ts`). `src/search.ts` and
`src/capture.ts` each export a `create<Area>Tools(config)` factory plus their
`*_DEFINITION` constants. `src/index.ts` aggregates both into
`createKnowledgeEngineTools` and `KNOWLEDGE_ENGINE_HUB_TOOLS`.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
