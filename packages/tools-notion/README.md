# @workbench/tools-notion

Notion tools for Workbench agents: `notion_search`, `notion_get_page`,
`notion_get_page_content`, `notion_get_database`, `notion_query_database`
(read-only) and `notion_create_page` (write).

- Credential (`notion` provider) is resolved by Interchange at tool execution
  time. The secret is an internal integration token; every request also sends
  the pinned `Notion-Version` header (`2022-06-28` by default). Only content
  shared with the integration is visible.
- `notion_create_page` WRITES to Notion — agents should use it only after
  explicit human approval.
