# @workbench/tools-notion

Notion tool implementation. Registered in the hub's tool registry as
`notion_search`, `notion_get_page`, `notion_get_page_content`,
`notion_get_database`, `notion_query_database`, and `notion_create_page`.

- Read tools query the Notion REST API (`/v1/search`, `/v1/pages/{id}`,
  `/v1/blocks/{id}/children`, `/v1/databases/{id}`, `/v1/databases/{id}/query`)
- `notion_create_page` (`POST /v1/pages`) is the only WRITE — it must be gated
  on explicit human approval by the calling agent
- Every request sends the `Notion-Version` header; it is pinned to a known
  version so response shapes stay stable
- Credential (`notion` provider) is resolved by Interchange at tool execution
  time — not at agent launch
- The tool grants `tool:<name>/invoke` are synthesized at session launch from
  the agent's capabilities list; do not add them to the DB
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
