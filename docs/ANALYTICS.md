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

Per-model rollups split **turns** (`message.run.ended`, `model` null) from **tokens** (`inference.done`, real model id). Insights `byModel` includes any named model with turns or tokens in range (null-model turn-only buckets are excluded).

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
- `GET /api/tenants/:tenantId/principals/:principalId/analytics` — a single principal's tool-call breakdown and token/cost totals, for the Insights principal trace's **Tools** and **Cost** facets. Returns `{ tools: [{ name, calls, errors }], cost: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens, inferenceCalls, toolCalls } }`. See **Per-principal Tools & Cost facets** below.
- `GET /api/tenants/:tenantId/activity/overview` — tenant operational ledger (`startDate`, `endDate`): artifact and workflow-run counts from hub tables, agent-instance lifecycle counts, plus:
  - `dailySeries` — per-`bucket_date` inference rollup (turns, tool calls, token categories), ordered ascending, for trend sparklines and the activity heatmap
  - `models` — `{ key, count }` legacy mini-chart values per `model` (turn count when `turnCount > 0`, else total tokens across classes); prefer `byModel` for cost and token classes
  - `conversations` / `messages` — `agent_session` and `inference_turn` counts (`total` + `createdInRange`)
  - `agentActivity` — `{ active, idle }` from `inference.byInstance` (CL-2891): for **date-bounded** presets, `active` = instances with turns in range, `idle` = instances in the same scoped set with zero turns (not “all instances minus active”). For **All time** (no date bounds), `idle` = all-time instance total minus `active`.
  - `pricedByModel` — tenant-wide `priceUsageRows(byModel)` when the hub had a warm models.dev catalog at overview time; `null` when not (the web may fall back to `GET /pricing` + the same math). Added CL-2891.
  - `inference.summary`, `inference.byAgent`, `inference.byInstance` from `analytics_rollup_daily`, plus `inference.previousSummary` — the equal-length window immediately before the selected range (or `null` for all-time), used for period-over-period deltas in the UI
  - `byPerson` — token/turn usage attributed to the member who owns each instance via `member_agent_instance` (shared-agent instances, with no member link, are excluded)
  - `byWorkflowType` — token/turn usage grouped by workflow `kind`, including all five token classes and per-kind `cost` when a catalog was available (CL-2891). Workflow-run inference records against per-deployment agent instances whose `address` embeds the deployment id (`ins_<deploymentId>…`); the query rejoins `agent_instance` and matches that prefix to `workflow_run.kind`. Deployments are deduped to one `(deploymentId, kind)` first (kind is constant per deployment) so a deployment with multiple runs cannot fan out and double-count. Non-workflow agents (Myra, member instances) have no matching `workflow_run` row and are excluded. Surfaced as the **Tokens by workflow type** table, which replaced the per-agent table on the UI.

The Insights UI presets are `24 hours`, `7 days`, `30 days`, `90 days`, and `All time`; `24 hours` resolves to a `startDate` one day back (analytics are daily-bucketed). Token metrics (token mix, per-person tokens, per-workflow-type tokens) are always shown when real tokens exist for the range; a range that starts before token recording began (`tokensRecordedFrom`) is flagged with an inline caveat note rather than hiding the numbers.

## Cost & token classes (CL-2714)

- **Token classes are always kept separate** — fresh input, cache read, cache write, and output are billed at different rates and are never summed into an ambiguous "prompt tokens" figure. `activity/overview` carries every class separately on `dailySeries`, `inference.*`, `byPerson`, and `byModel` (per-model usage with all classes, CL-2714).
- **Legacy `activity/overview.models[].count`** — `analyticsModelDisplayCount`: turn count when `turnCount > 0`, else total tokens across classes (mixed units; consumers outside Insights Usage & Cost may still use this).
- **Insights Usage & Cost “Model distribution” mini-bars (CL-3740)** — bar length is always total tokens across classes (`sumAnalyticsModelTokens`); the value column shows `N turns` when `turnCount > 0`, else a compact token total, so bars are comparable across models.
- **Dollar cost** is computed from [models.dev](https://models.dev) open pricing. The hub fetches `MODELS_DEV_API_URL` (default `https://models.dev/api.json`), ArkType-parses it at the boundary (`@workbench/pricing` → `ModelsDevPayloadSchema`), and flattens it into a `modelId → per-class rate` catalog cached **in-process** with a TTL (`MODELS_DEV_TTL_MS`, default 6h — the hub has no redis). Rates are dollars per million tokens.
  - `GET /api/tenants/:tenantId/pricing` returns the cached `PriceCatalog`; the browser consumes it via TanStack Query (long `staleTime`) and never hits models.dev directly (CSP).
  - `GET /api/tenants/:tenantId/pricing/logos/:provider` proxies the provider SVG logo same-origin.
  - Cost = Σ over classes of `tokens_class × rate_class`, priced per model. A telemetry model with **no models.dev match shows tokens only and is marked "no rate"** — no dollar figure is fabricated (`resolveModelRate` → null, `computeCost` → null).
  - **Ambiguous bare model ids (CL-2714 / CL-2859):** Daily rollups store canonical catalog ids (e.g. `deepseek-v4-flash`). When models.dev lists the same bare id under multiple providers at different $/M rates, the catalog marks it `ambiguous` and a bare lookup stays **no rate** so the UI never guesses a host. `GET /pricing` and activity overview attach `offeringProvidersByModel` from the tenant's visible model catalog (`listVisibleOfferings`). `resolveModelRate` then tries qualified keys `{modelsDevProviderId}/{bareId}` for those offerings (via `@workbench/catalog` provider map). Pricing succeeds only when every resolved qualified variant shares one rate shape; conflicting tenant offerings stay **no rate**.
- Per-model dollars are exact (model is known). Per-day and per-actor rows have no per-model attribution, so those surfaces show **token classes** with dollars kept at the model/aggregate level rather than inventing a blended per-row rate.

### Insights dashboard alignment (CL-2891)

- **Range-first engagement KPIs** — Conversations, messages, and artifacts show **in-range** counts as the headline; all-time totals appear as the subtitle. This matches the selected date preset rather than mixing all-time totals with an in-range footnote.
- **Consistent token totals** — Sparklines, KPI deltas, per-person / per-workflow-type / instance tables, and the cost tab’s token headline all use the **sum of five classes** (input, output, cache read, cache write, thinking) via `@workbench/pricing`’s `sumTokenUsageClasses`, aligned with `metricsSeries.tokensSpent` on the hub.
- **Cost on the overview** — The web prefers hub `pricedByModel` when present; it only recomputes from `byModel` + the cached client catalog when the hub sent `null`. A banner appears when there is model usage but no price could be resolved after the catalog fetch settles.
- **Rolling deploy** — The web parser treats `pricedByModel` and per-workflow cache/thinking fields as optional on the wire and normalizes to `null` / zero so a newer UI can talk to a hub that has not yet shipped every CL-2891 field.

## Activity feed (CL-2714)

The Recent Activity feed re-frames raw timeline rows into legible, action-first headlines and groups a time-adjacent burst into one **turn** (a connected flow: the session, the grants it exercised, the tools it ran, the result). A `grant` row (`<resource> <action> <effect>`, e.g. `tool:workflows__workflow_start invoke allow`) is named by the ACTION it allowed ("Allowed: Workflow start") rather than a bare "GRANT". Naming + grouping are pure functions in `apps/web/src/pages/insights/activity-naming.ts` (no session id exists on timeline rows, so time-adjacency is the grouping signal).

Requires an active principal on the tenant (Interchange `resolveTenant` on `/api/tenants/:tenantId/*`). Org members do not carry role grants; analytics is membership-gated like other product reads.

## Activity timeline limits — grants & credentials (CL-2489)

Principal and tenant-wide **activity timelines** (`GET …/activity/timeline`, `@workbench/timeline`) UNION **13** registered sources (`packages/timeline/src/registry.ts`). They surface operational **activity** — what was recorded and what still exists — not a tamper-evident audit trail.

| Limit | Detail |
| ----- | ------ |
| **Grant rows** | Read live `grant` rows; timestamp is `created_at` (first insert). Revoked or deleted grants vanish from the feed; there is no history of who granted, changed, or removed access. |
| **Credential rows** | Same for `credential` (member OAuth and owner-managed keys). Rotation or disconnect removes or leaves a stale `created_at`; secrets and prior values are never replayed on the timeline. |
| **Not audit-grade** | No append-only mutation log, no actor on change, no hash chain. Operators must not treat Insights **Activity** as permissions or secrets compliance evidence. |

The web shows an inline caveat when grant or credential entries appear, via one shared `PermissionCaveatBanner` (`apps/web/src/pages/insights/PermissionCaveatBanner.tsx`) rendered by every timeline surface (`ActorTimeline`, `MomentWalker`, `TenantActivityFeed`) so the disclosure wording is identical everywhere. The grant descriptor note in `packages/timeline/src/registry.ts` documents current-state semantics; the credential descriptor note covers tenant-owned exclusion, not mutation history.

**Mutation paths (v1).** Timeline SQL does not subscribe to writes. Grants and credentials mutate through the **hub process** — both workbench-specific code under `apps/hub/src` and the mounted `@intx/hub-api` routes (`/api/tenants/:tenantId/grants`, `/api/tenants/:tenantId/credentials`, plus instance launch grant materialization). Inventory for documentation and a future audit hook:

- **Workbench grants (`apps/hub/src`):** `routes/owner.ts`, `routes/agents.ts`, `routes/gamma-templates.ts`, `services/agent-provisioning.ts`, `services/myra-threads.ts`, `lib/capability-grants.ts`, `lib/feature-grants.ts`, `lib/workflow-run-gate.ts`, `lib/tenant-provisioning.ts`, `lib/workspace-inbox-source-gate.ts`
- **Interchange API (mounted by hub):** `interchange/packages/hub-api/src/routes/grants.ts`, `routes/credentials.ts`, `routes/instances.ts` (launch-time grant rows)
- **Workbench credentials (`apps/hub/src`):** `routes/owner.ts`, `routes/me-connections.ts` (disconnect), `lib/oauth-flow.ts` (connect store / disconnect delete)

**Deferred v1:** an append-only hub table written at mutation sites would give a real audit stream without overloading the in-place `grant` / `credential` tables.

## Tenant-wide activity + intra-tenant authz (CL-2743 / CL-2744)

- **Default surface is the whole tenant.** `GET /api/tenants/:tenantId/activity/timeline` returns the same `@workbench/timeline` union scoped to the tenant across ALL principals (every user, agent instance, and workflow run), keyset-paginated. It uses the `TENANT_WIDE_SCOPE` (`"all"`) sentinel on `TimelineScope.principalIds`, which drops the per-branch principal predicate; each source still carries its mandatory tenant predicate, so cross-tenant rows never resolve. `getTenantActivityPage` is the service; `getTenantActivity` the client fn; `useTenantActivity` the infinite hook. The web `TenantActivityFeed` is the MIDDLE band of Insights (below the charts), with every entity row deep-linking into its own trace.
- **Activity is open intra-tenant.** The per-principal routes — activity timeline, moment detail (`/:kind/:id/detail`), and roster — no longer default-deny a caller viewing another principal in the same tenant. Any tenant member may read any member's activity/roster/detail within their tenant; tenant membership (enforced by `resolveTenant`) is the only boundary. Cross-tenant stays hard-blocked by tenant scoping (the union's tenant predicate + `resolveTenant`). The former `activity:principal`/`read` grant gate was removed from all three routes. The web 403 "no permission" states (CL-2734) remain as a safety net but no longer fire for same-tenant reads.
- **Per-user is a drill-down.** `/insights/users/:id` is the tenant view filtered to one principal (the existing principal trace page); the dashboard actor search and the "Usage by person" table link into it.

## Progressive loading + cache (CL-2753)

The tenant-wide activity feed is the heaviest Insights query — a per-row UNION across interchange-owned tables we are not allowed to index — and it previously ran on EVERY Insights open. The landing surface is split from it:

- **Landing = cheap aggregate only.** Opening Insights loads only `GET /api/tenants/:tenantId/activity/overview` (charts, KPIs, cost) — aggregates over workbench-owned, indexable tables (`analytics_rollup_daily`, `workflow_run_fact`/`workflow_step_fact`, identity joins). The tenant-wide activity UNION is NOT eager-loaded.
- **The activity feed is deferred.** `apps/web/src/pages/insights/DeferredActivitySection.tsx` renders a "Show activity feed" disclosure in the Activity band; `TenantActivityFeed` (and therefore `useTenantActivity` → the UNION) mounts only when a member opens it — gating the mount, not just the query's `enabled`, so before reveal there is no request at all. The actor search (`ActorActivitySection`) was already query-gated (fires only on a ≥2-char search), and per-moment / per-principal content (memory snippets, tool I/O) still loads only on drill-down — so the tenant-wide firehose never carries F2-sensitive free text by default (the `tenantWideSummarySql` redaction from CL-2743 stays the default; the authz-scoped drill-down keeps the full summary).
- **Two caching layers.** (1) App-level: `useTenantActivity` holds pages fresh for 45s (`staleTime`), so a re-open inside the window does not re-run the UNION. (2) Server-level: `getCachedTenantActivityPage` (`apps/hub/src/services/tenant-activity-cache.ts`) memoizes the tenant-wide FIRST page in-process for `INSIGHTS_TENANT_ACTIVITY_CACHE_TTL_MS` (default 45s), keyed `${tenantId}:${limit}`, with single-flight de-dup — so several members of a busy tenant opening the feed inside the window collapse onto ONE DB union. Scope is deliberately narrow: only the redacted tenant-wide first page is cached (deep cursor pages and the per-principal drill-down use different code paths and are never memoized), and the `${tenantId}` key keeps cross-tenant isolation airtight. In-process only (the hub has no redis), mirroring the models.dev pricing TTL cache in `lib/pricing.ts`.
  - **Single-replica correctness.** The server-level cache lives in one hub process and is only correct while the hub runs a single replica (per CL-2646). A future scale-out to multiple hub replicas would give each replica its own map with no shared invalidation — it would need a cross-replica invalidation mechanism (or a shared store) before the TTL memo can be trusted.
  - **Compounded worst-case staleness.** The two TTLs stack: the client `staleTime` (45s) sits in front of the server TTL (45s), so a page the browser holds can be up to ~90s stale on the tenant-wide feed in the worst case (browser serves a 45s-old page whose server entry was itself stamped 45s before that read).

## Per-principal Tools & Cost facets

The Insights principal trace (`/insights/users/:id`) has **Tools** and **Cost** facets that aggregate the **durable `analytics_event` fact table** for one principal, scoped to the same attribution set as the activity timeline (`resolveTimelinePrincipalIds` — the principal plus the synthetic principals of any agent instances it owns via `member_agent_instance`). They read the raw facts, **not** the loaded timeline window, so counts and cost reflect the principal's full recorded history rather than the first page.

- **Service / route:** `getPrincipalAnalytics` (`apps/hub/src/services/principal-analytics.ts`) behind `GET /…/principals/:principalId/analytics` (`createPrincipalAnalyticsRouter`). Client: `getPrincipalAnalytics`; web hook: `usePrincipalAnalytics` (both facets share one query key, so they issue a single request).
- **Tools** — `getPrincipalToolBreakdown` (`@workbench/analytics`) groups `event_type = 'tool_call'` rows by tool name with call and error counts. Token/cost columns are zero on tool-call rows, so cost is never attributed to a tool. The tool **name** is not stored on the fact row yet; it is recovered from `turn_part` (`type = 'tool'`, metadata `{ callId, name }`) via a `LATERAL … LIMIT 1` join that yields at most one name per fact row (the collector writes a `tool` part on both the `inference.done` tool-call block and the `tool.done` result, so a plain join would fan out and double-count). When `turn_part` has been reaped with its instance, the name falls back to the raw `tool_call_id`.
- **Cost** — `getPrincipalCostSummary` sums the token classes over `inference_done` rows (tokens live only there) and tallies `tool_call` rows separately. The facet renders per-class token counts; **dollar pricing is a separate layer** (see Cost & token classes) and is not applied per-principal here.
- **Attribution note:** keying on the principal set is correct for persistent chat agents, which resume in place under one stable instance principal. An agent whose history spans multiple instances (re-provisioning) or whose analytics was recorded under a since-reaped ephemeral instance is out of scope for these facets — that cross-instance aggregation keys on the durable `analytics_event.agent_id` and is tracked separately.

## Staging verification (CL-2301)

1. Deploy staging hub + sidecar with analytics migrations applied.
2. Open a workbench tenant in the web app → **Data & Insights**.
3. Send at least one message to a deployed agent instance; confirm **Total turns** and token rows increase within the selected date preset.
4. Run a multi-step workflow deployment and complete one step that invokes inference; confirm supervisor-address events appear (hub logs: no `Skipping analytics event for unknown agent address` for the deployment supervisor).
5. Call `GET /api/tenants/<tenantId>/analytics/summary` with a session cookie; validate JSON fields against the UI.
6. Optional: `GET .../summary/by-agent` to confirm per-agent split matches known agents.
7. **`byWorkflowType`** — the address→`workflow_run.kind` LIKE join has no live-DB unit coverage (the hub suite mocks the db chain). After a workflow run completes on staging, confirm its kind appears in the **Tokens by workflow type** table with non-zero tokens, and that totals across kinds do not exceed the tenant token summary (a fan-out regression would inflate them).

## Operational notes

- Daily buckets are **UTC** (`bucket_date`).
- Event keys are scoped as `{sessionId}:{agentAddress}:{seq}:{type}` for idempotency across restarts.
- Unknown `agent_address` (no active `agent_instance`) is dropped with a warning — fix deploy persistence before expecting workflow analytics.
- Workflow supervisors persist harness `sessionId` on `agent_instance` (and `agent_session`) at deploy/re-establish so inference events resolve for analytics.
- **Backfill** supervisors deployed before that fix: `bun run apps/hub/bin/backfill-analytics-sessions.ts --tenant <slug> --dry-run` then without `--dry-run`.

## Troubleshooting

### Read-only model rollup audit (CL-3740)

When Insights **by model** looks wrong (missing models, token-only rows, or stale rollups), run the read-only audit script against staging or production Postgres. It prefers `DATABASE_PUBLIC_URL` (Railway’s public proxy) and refuses `*.railway.internal` URLs so local `psql` can connect.

From the repo root, attach to the **Postgres** service so Railway injects the DB URL, and merge tenant/hub env from the matching file:

```bash
railway run -e corbits-workbench-staging -s Postgres -- \
  bun --env-file=.env.staging scripts/analytics-models-readonly.ts staging
```

Production:

```bash
railway run -e corbits-workbench-production -s Postgres -- \
  bun --env-file=.env.production scripts/analytics-models-readonly.ts production
```

The script runs `psql` with `default_transaction_read_only = on` and prints:

- **tenants** — sample tenant rows (pick `tenant_id` for ad-hoc SQL below)
- **per_model_rollups_30d** — `analytics_rollup_daily` grouped by `model` (turns + total tokens)
- **token_only_named_models_30d** — named models with tokens but zero turns (inference-only rollup shape)
- **inference_done_by_model_30d** — raw `inference_done` event counts by `metadata.model`

Rollup and event sections are **not tenant-scoped** — they aggregate across all tenants in the database. Use only on trusted operator machines; filter by `tenant_id` in ad-hoc SQL when you need one tenant.

Requires `psql` on your PATH. If you see “No reachable DATABASE URL”, you are not running under `railway run -s Postgres` or the service is missing `DATABASE_PUBLIC_URL`.

### Staging SQL (read-only checks)

```sql
-- Supervisors missing session (analytics will drop events)
SELECT id, address, status FROM agent_instance
WHERE session_id IS NULL AND id = agent_id AND id LIKE 'ins_%' AND ended_at IS NULL;

-- Today's rollup totals for a tenant
SELECT sum(turn_count), sum(input_tokens), sum(output_tokens)
FROM analytics_rollup_daily WHERE tenant_id = '<tenantId>' AND bucket_date = current_date;
```
