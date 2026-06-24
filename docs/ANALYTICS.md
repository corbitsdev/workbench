# Analytics (Insights)

GTM Workbench records agent and workflow usage in PostgreSQL and exposes tenant-scoped rollups for the **Data & Insights** UI (`/insights`).

## Architecture

| Layer                  | Responsibility                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@workbench/analytics` | Event mapping, fact + daily rollup persistence, Hono routes                                                                      |
| Hub                    | Subscribes to sidecar `agent.event` frames; mounts `/api/tenants/:tenantId/analytics/*`                                          |
| Sidecar                | Forwards harness inference events (chat agents) and **multi-step workflow** supervisor events to the hub via `hubLink.sendEvent` |
| Web                    | `getAnalyticsSummary` → Insights KPI cards                                                                                       |

Inference events flow: **sidecar harness / workflow child → hub `sidecarRouter.events` → `createAnalyticsSubscriber` → `analytics_event` + `analytics_rollup_daily`.**

## Event coverage matrix

| Source                                   | Event types ingested                                                                     | Rollup contribution                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Chat agent (Myra, Oat, …)                | `inference.usage`, `inference.done`, `inference.error`, `tool.done`, `message.run.ended` | Turns/tools from run boundaries; **tokens from `inference.done` only** (usage stored as raw facts) |
| Multi-step workflow (supervisor address) | Same inference vocabulary from workflow-process child                                    | Same rules; requires deploy frame `config.sessionId` and supervisor `agent_instance` row           |
| Feedback / workflow product actions      | Not in v1 analytics schema                                                               | Use `output_feedback` and workflow_run tables for product metrics                                  |
| CRM / Attio / external sync              | **No dedicated analytics stream**                                                        | Counted when agents call those integrations via **`tool.done`** (tool call + error rollups)        |

## API

- `GET /api/tenants/:tenantId/analytics/summary` — tenant totals (`startDate`, `endDate`, `agentId`, `instanceId` query params)
- `GET /api/tenants/:tenantId/analytics/summary/by-agent` — per-`agentId` breakdown (same filters)

Requires grant `analytics:*` read on the tenant.

## Staging verification (CL-2301)

1. Deploy staging hub + sidecar with analytics migrations applied.
2. Open a workbench tenant in the web app → **Data & Insights**.
3. Send at least one message to a deployed agent instance; confirm **Total turns** and token rows increase within the selected date preset.
4. Run a multi-step workflow deployment and complete one step that invokes inference; confirm supervisor-address events appear (hub logs: no `Skipping analytics event for unknown agent address` for the deployment supervisor).
5. Call `GET /api/tenants/<tenantId>/analytics/summary` with a session cookie; validate JSON fields against the UI.
6. Optional: `GET .../summary/by-agent` to confirm per-agent split matches known agents.

## Operational notes

- Daily buckets are **UTC** (`bucket_date`).
- Event keys are scoped as `{sessionId}:{agentAddress}:{seq}:{type}` for idempotency across restarts.
- Unknown `agent_address` (no active `agent_instance`) is dropped with a warning — fix deploy persistence before expecting workflow analytics.
- Workflow supervisors persist harness `sessionId` on `agent_instance` (and `agent_session`) at deploy/re-establish so inference events resolve for analytics.
- **Backfill** supervisors deployed before that fix: `bun run apps/hub/bin/backfill-analytics-sessions.ts --tenant <slug> --dry-run` then without `--dry-run`.

### Staging SQL (read-only checks)

```sql
-- Supervisors missing session (analytics will drop events)
SELECT id, address, status FROM agent_instance
WHERE session_id IS NULL AND id = agent_id AND id LIKE 'ins_%' AND ended_at IS NULL;

-- Today's rollup totals for a tenant
SELECT sum(turn_count), sum(input_tokens), sum(output_tokens)
FROM analytics_rollup_daily WHERE tenant_id = '<tenantId>' AND bucket_date = current_date;
```
