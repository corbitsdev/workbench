# @workbench/tools-sumble

Read tools over the [Sumble](https://sumble.com) v8 API for company, team,
people, jobs, tech-stack, and buying-signal intelligence.

## Provider

- Provider name: `sumble`
- Factory id: `@workbench/tools-sumble/sumble`
- Auth: `Authorization: Bearer <apiKey>` against `https://api.sumble.com/v8`
  (override with `config.baseUrl`).
- The `sumble` credential is resolved by Interchange at tool execution time.
- The API key is set by the Owner on the **Capabilities** page (the `sumble`
  entry in `CREDENTIAL_PROVIDER_CATALOG`); it is not seeded from an env var.

## Tools

| Tool                            | Endpoint                    | Notes                                    |
| ------------------------------- | --------------------------- | ---------------------------------------- |
| `sumble_resolve_organization`   | `POST /organizations`       | Resolve a company by domain/slug/name.   |
| `sumble_search_organizations`   | `POST /organizations`       | Filter by query/industry/employee range. |
| `sumble_get_org_tech_stack`     | `POST /organizations`       | Technologies + job-post counts.          |
| `sumble_list_teams`             | `POST /teams`               | Teams with ICP-fit scores.               |
| `sumble_search_people`          | `POST /people`              | Async (polled).                          |
| `sumble_list_jobs`              | `POST /jobs`                | Open jobs with detected technologies.    |
| `sumble_search_signals`         | `POST /signals`             | Buying/intent signals.                   |
| `sumble_get_intelligence_brief` | `POST /intelligence-briefs` | Async (polled). **Cost-gated.**          |

## Cost gate

`sumble_get_intelligence_brief` costs **50 credits per completed brief**. The
tool refuses unless the caller passes `confirmSpend: true`; without it no API
call is made and nothing is spent.

## Async polling

`sumble_search_people` and `sumble_get_intelligence_brief` may return `202
Accepted` with a `Retry-After` header while the result is computed. Both tools
re-POST the same request after `Retry-After` seconds, up to 10 attempts,
respecting the abort signal. If the work does not complete within the attempt
cap the tool fails loudly rather than returning a partial result.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
