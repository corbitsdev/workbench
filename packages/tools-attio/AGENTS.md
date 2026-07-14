# @workbench/tools-attio

Attio CRM tool implementation. Registered in the hub's tool registry.

## Read tools

- `attio_list_objects` — list the workspace's objects (`GET /v2/objects`)
- `attio_query_records` — structured query against one object (`POST /v2/objects/{object}/records/query`). Exposes flat `nameContains`/`domainContains` convenience params (mapped server-side to a `name`/`domains` `$contains` filter) so weak models reliably scope a lookup without authoring a nested filter; an explicit `filter` (`$eq`/`$contains`/`$starts_with`/`$ends_with`, implicit-AND across attributes) takes precedence and is passed through as-is, alongside `sorts`
- `attio_search_records` — fuzzy free-text match across people and companies (`POST /v2/records/search`)
- `attio_get_record` — fetch one record by object slug + id (`GET /v2/objects/{object}/records/{recordId}`)
- `attio_list_workspace_members` — list workspace members (`GET /v2/workspace_members`)
- `attio_list_tasks` / `attio_get_task` — list and fetch tasks (`GET /v2/tasks`, `GET /v2/tasks/{taskId}`); `attio_get_task` hydrates linked records by default

## Write tools

These WRITE to Attio and are approval-gated (`sideEffect: "write"`): a call opens the human ReviewGate before it runs. Each is listed in `APPROVAL_GATED_TOOL_NAMES` in `@workbench/agents`, enforced by the `approval-gated-tools.test.ts` drift guard.

- `attio_update_task` — set a task's `isCompleted` and/or `deadlineAt` (`PATCH /v2/tasks/{taskId}`)
- `attio_create_note` — attach a note to a record (`POST /v2/notes`); pass `idempotencyKey` to make the write retry-safe (a matching prior note is returned instead of duplicating)
- `attio_create_record` — create a record for an object (`POST /v2/objects/{object}/records`, values wrapped in `data.values`); pass `matchingAttribute` to upsert via Attio's assert endpoint (`PUT …/records?matching_attribute=…`) so a retried create matches an existing record instead of duplicating

## Wiring

- Credential (`attio` provider) is resolved by Interchange at tool execution time — not at agent launch
- The tool grants `tool:<name>/invoke` are synthesized at session launch from the agent's capabilities list; do not add them to the DB
- A new write tool must declare `sideEffect: "write"` on its hub entry (and regen manifests); the drift guard derives gating from that classification
- Keep the tool schemas in sync with what agents declare in their system prompts

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
