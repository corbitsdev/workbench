# @workbench/tools-corbits-knowledge-engine

Tools that call the standalone Corbits knowledge engine over HTTP, so
workbench agents can search and add to the team's shared knowledge base.

## Tools

- `search_company_knowledge({ query, k? })` — `POST {baseURL}/api/search`
  with `{ query, tenant_id, principal_id, k }`. Returns ranked hits
  (`documentId`, `title`, `snippet`, `score`).
- `capture_to_knowledge({ kind, title, externalRef, text | chunks, entityHints?, edges?, visibilityMode?, visibilityPrincipalIds?, sourceClass? })`
  — `POST {baseURL}/api/capture` with the document shape the engine expects
  (`visibility`, `entityHints`, `chunks`, `actor`, `contentHash`, …). Returns
  `{ documentId, versionId, chunks, status }`.

`tenant_id`/`principal_id` are always resolved from the tool-execution
context (the sidecar's hub-RPC context), never from the agent's tool-call
arguments — an agent cannot point either tool at another tenant.

## Credential

Keyed. Provider name: `corbits-knowledge-engine`.

- Secret: a service token (`KNOWLEDGE_ENGINE_TOKEN` at seed time), sent as
  `Authorization: Bearer <token>`.
- Base URL: the engine's own HTTP origin (`KNOWLEDGE_ENGINE_URL` at seed
  time), stored on the credential's provider row as `metadata.baseURL` and
  delivered to the tool as `baseURL` — the same mechanism Firecrawl/Granola
  use for their base URLs.

Seed with `bun run seed-credentials` after setting `KNOWLEDGE_ENGINE_URL` and
`KNOWLEDGE_ENGINE_TOKEN`, or set both from the Owner → Capabilities page.
