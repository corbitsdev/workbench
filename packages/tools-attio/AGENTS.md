# @workbench/tools-attio

Read-only Attio CRM tool implementation. Registered in the hub's tool registry as `attio_list_objects`, `attio_query_records`, `attio_search_records`, `attio_get_record`, and `attio_list_workspace_members`.

- `attio_query_records` — structured query against one object (`POST /v2/objects/{object}/records/query`) with optional `filter` (`$eq`/`$contains`/`$starts_with`/`$ends_with`) and `sorts`, passed through as-is
- `attio_search_records` — fuzzy free-text match across people and companies (`POST /v2/records/search`)

- Credential (`attio` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants `tool:<name>/invoke` are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- These tools are READ-ONLY — they never create, update, or delete CRM data
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
