# @workbench/tools-sumble

Hub tools for the [Sumble](https://sumble.com) **Public API v9** — organizations,
teams, people, jobs, signals, lookups, saved lists, support, and intelligence
briefs.

## Provider

- Provider name: `sumble`
- Factory id: `@workbench/tools-sumble/sumble`
- Auth: `Authorization: Bearer <apiKey>` against `https://api.sumble.com` with
  `/v9/` paths (override with `config.baseUrl`; a base ending in `/v8` keeps
  legacy path shape for older deployments).
- The `sumble` credential is resolved by Interchange at tool execution time.
- Configure the API key on the Owner **Capabilities** page (`sumble` in
  `CREDENTIAL_PROVIDER_CATALOG`).

## Tool surface

**32 hub tools** cover all **25** documented v9 HTTP operations (see
`src/operation-coverage.ts` and `src/openapi-parity.test.ts`). Ergonomic tools
wrap common workflow shapes; `sumble_post_*` tools pass full request bodies for
advanced queries.

| Category        | Examples                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Enrich          | `sumble_resolve_organization`, `sumble_search_organizations`, `sumble_get_org_tech_stack`, `sumble_list_teams`, `sumble_list_jobs` |
| People          | `sumble_search_people` (async polled; optional `revealEmail` + `confirmEmailRevealSpend`)                                          |
| Signals         | `sumble_search_signals`, `sumble_get_organization_signals`, `sumble_search_priority_signals`                                       |
| Lookups         | `sumble_lookup_job_titles`, `sumble_lookup_technologies`, `sumble_find_technologies`, …                                            |
| Lists (write)   | `sumble_create_contact_list`, `sumble_add_contact_list_people`, `sumble_create_organization_list`, …                               |
| Support (write) | `sumble_create_support_request`, `sumble_create_data_quality_report`                                                               |
| Brief           | `sumble_get_intelligence_brief` (GET per org id; **cost-gated**)                                                                   |

## Cost gates

- `sumble_get_intelligence_brief`: **50 credits** — requires `confirmSpend: true`.
- `sumble_search_people` with `revealEmail: true`: up to **10 credits per email**
  revealed — requires `confirmEmailRevealSpend: true`.
- `sumble_search_people` lookup by **email** identifier: up to **20 credits** —
  same `confirmEmailRevealSpend: true` gate.

## Async polling

`sumble_search_people` and `sumble_get_intelligence_brief` may return `202` with
`Retry-After`. The client polls up to 10 times and respects the abort signal.

## Testing

```bash
bun run --filter @workbench/tools-sumble test
```

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
