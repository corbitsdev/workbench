# Analytics (Insights)

GTM Workbench records agent and workflow usage in PostgreSQL and exposes tenant-scoped rollups for the **Data & Insights** UI (`/insights`).

## Architecture

| Layer                  | Responsibility                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@workbench/analytics` | Event mapping, fact + daily rollup persistence, Hono routes                                                                                                                                                                                        |
| Hub                    | Subscribes to sidecar `agent.event` frames; mounts `/api/tenants/:tenantId/analytics/*`                                                                                                                                                            |
| Sidecar                | Forwards harness inference events (chat agents) and **multi-step workflow** supervisor events to the hub via `hubLink.sendEvent`                                                                                                                   |
| Hub (activity)         | `GET /api/tenants/:tenantId/activity/overview` — operational counts (artifacts, workflow runs, instances), daily inference series, model distribution, conversation/message counts, agent-activity split, and a previous-window summary for deltas |
| Web                    | `getActivityOverview` → Insights activity trends, engagement metrics, inference KPIs, per-person and per-workflow-type token tables, and operational ledger                                                                                        |

Inference events flow: **sidecar harness / workflow child → hub `sidecarRouter.events` → `createAnalyticsSubscriber` → `analytics_event` + `analytics_rollup_daily`.**

## Event coverage matrix

| Source                                   | Event types ingested                                                                     | Rollup contribution                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Chat agent (Myra, Oat, …)                | `inference.usage`, `inference.done`, `inference.error`, `tool.done`, `message.run.ended` | Turns/tools from run boundaries; **tokens from `inference.done` only** (usage stored as raw facts)     |
| Multi-step workflow (supervisor address) | Same inference vocabulary from workflow-process child                                    | Same rules; requires deploy frame `config.sessionId` and supervisor `agent_instance` row               |
| Feedback / workflow product actions      | Not in v1 analytics schema                                                               | Workflow executions and artifacts surface on **activity/overview**; feedback remains `output_feedback` |
| CRM / Attio / external sync              | **No dedicated analytics stream**                                                        | Counted when agents call those integrations via **`tool.done`** (tool call + error rollups)            |

## API

- `GET /api/tenants/:tenantId/analytics/summary` — tenant totals (`startDate`, `endDate`, `agentId`, `instanceId` query params)
- `GET /api/tenants/:tenantId/analytics/summary/by-agent` — per-`agentId` breakdown (same filters)
- `GET /api/tenants/:tenantId/analytics/summary/by-instance` — per-`instanceId` breakdown (same filters)
- `GET /api/tenants/:tenantId/activity/overview` — tenant operational ledger (`startDate`, `endDate`): artifact and workflow-run counts from hub tables, agent-instance lifecycle counts, plus:
  - `dailySeries` — per-`bucket_date` inference rollup (turns, tool calls, token categories), ordered ascending, for trend sparklines and the activity heatmap
  - `models` — `{ key, count }` turn counts grouped by `model`
  - `conversations` / `messages` — `agent_session` and `inference_turn` counts (`total` + `createdInRange`)
  - `agentActivity` — `{ active, idle }`: instances with vs. without turns in range (derived from `inference.byInstance`)
  - `inference.summary`, `inference.byAgent`, `inference.byInstance` from `analytics_rollup_daily`, plus `inference.previousSummary` — the equal-length window immediately before the selected range (or `null` for all-time), used for period-over-period deltas in the UI
  - `byPerson` — token/turn usage attributed to the member who owns each instance via `member_agent_instance` (shared-agent instances, with no member link, are excluded)
  - `byWorkflowType` — token/turn usage grouped by workflow `kind`. Workflow-run inference records against per-deployment agent instances whose `address` embeds the deployment id (`ins_<deploymentId>…`); the query rejoins `agent_instance` and matches that prefix to `workflow_run.kind`. Deployments are deduped to one `(deploymentId, kind)` first (kind is constant per deployment) so a deployment with multiple runs cannot fan out and double-count. Non-workflow agents (Myra, member instances) have no matching `workflow_run` row and are excluded. Surfaced as the **Tokens by workflow type** table, which replaced the per-agent table on the UI.

The Insights UI presets are `24 hours`, `7 days`, `30 days`, `90 days`, and `All time`; `24 hours` resolves to a `startDate` one day back (analytics are daily-bucketed). Token metrics (token mix, per-person tokens, per-workflow-type tokens) are always shown when real tokens exist for the range; a range that starts before token recording began (`tokensRecordedFrom`) is flagged with an inline caveat note rather than hiding the numbers.

Requires an active principal on the tenant (Interchange `resolveTenant` on `/api/tenants/:tenantId/*`). Org members do not carry role grants; analytics is membership-gated like other product reads.

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
