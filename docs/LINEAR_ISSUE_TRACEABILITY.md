# Linear GraphQL expansion — issue traceability

Single PR branch `expand-linear-graphql-api` implements the CL-3592 umbrella. Each child issue maps to tools, tests, or documented unsupported operations in `docs/LINEAR_TOOLS.md`.

| Issue | Outcome |
|-------|---------|
| CL-3592 | Shared client (`client.ts`), pagination (`pagination.ts`), arktype args (`shared.ts`), hub wiring (`hub-tools.ts`, `tool-runtime.ts`) |
| CL-3593 | `linear_list_issues`, `linear_get_issue`, filters, cursor pagination, brief `enabledSources` |
| CL-3594 | `linear_update_issue` (incl. cycle, milestone, labels, estimate, due date), archive, delete, `linear_link_issues` |
| CL-3595 | Comments, attachments, documents; customer needs via `linear_get_issue` + `includeCustomerNeeds` |
| CL-3596 | Projects, milestones, releases; unsupported items listed in LINEAR_TOOLS.md |
| CL-3597 | Initiatives list/save; sub-initiative linking documented unsupported |
| CL-3598 | `linear_list_cycles`; cycle create/update documented unsupported |
| CL-3599 | Teams, users, labels, statuses, templates via list tools; workflow config edits unsupported |
| CL-3607 | **Not in this PR** — Sumble UI views/filters (separate provider). Linear-side search/views: `linear_search`, `linear_list_views` |
| CL-3608 | `linear_list_dashboards` with unsupported matrix for graph/export APIs |
| CL-3609 | Webhooks CRUD + `linear_list_integrations` (read metadata) |
| CL-3610 | Co-located `*.test.ts`, `integration-workflows.test.ts`, `LINEAR_TOOLS.md`, this matrix |

Tests: `cd packages/tools-linear && bun test --isolate`.