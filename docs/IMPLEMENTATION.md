# GTM Workbench — Implementation Documentation

## Technology Stack

| Layer              | Technology     | Version                      |
| ------------------ | -------------- | ---------------------------- |
| Package manager    | Bun            | 1.2+                         |
| Frontend           | React          | 19                           |
| Frontend build     | Vite           | 8                            |
| Styling            | Tailwind CSS   | 4                            |
| Animation          | Framer Motion  | 12                           |
| State management   | TanStack Query | 5                            |
| Backend            | Hono           | 4                            |
| ORM                | Drizzle ORM    | 0.45                         |
| Database           | PostgreSQL     | 18.2-alpine                  |
| Object storage     | MinIO          | latest                       |
| Agent runtime      | `@intx/agent`  | workspace (via interchange/) |
| Runtime validation | arktype        | 2.x                          |

## TypeScript Configuration

- Extends `tsconfig.base.json` from interchange
- `strict: true`
- `noUncheckedIndexedAccess: true` — check array/object access before using
- `exactOptionalPropertyTypes: true` — optional props cannot be `undefined`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- No `any`, no `as` type assertions. Use `unknown` and narrow.

## File Organization

- **Applications**: `apps/web/`, `apps/hub/`
- **Shared libraries**: `packages/*`
- **Examples**: `examples/*` (reference consumers, not throwaway)
- No standalone TypeScript files in repository root

## Shared Packages

### `apps/sidecar/` — Tool Runner

The sidecar carries three tool runners merged via `mergeToolRunners` before `filterToolRunner` gates model-visible definitions to whatever the hub configured in `HarnessConfig.tools`:

| Runner               | Source                                | What it covers                                            |
| -------------------- | ------------------------------------- | --------------------------------------------------------- |
| `posixTools`         | `@intx/tools-posix`                   | File system, shell, LSP                                   |
| `askPrincipalRunner` | `@workbench/approvals`                | Human approval flow (calls hub `/api/internal/approvals`) |
| `hubToolRunner`      | `apps/sidecar/src/hub-tool-runner.ts` | All hub-managed tools (exa, granola, etc.)                |

`HubToolRunner` is generic — it forwards every tool call to `POST /api/internal/tools/run` using `sidecarToken` auth. It has no knowledge of specific tools. Adding a new tool package never requires a sidecar change.

#### Harness construction

The merged `ToolRunner` is wrapped as an Interchange `toolFactory` via `defineTool` (from `@intx/agent`) and passed in `toolFactories` on the `AgentDefinition` — **not** via an `env.tools` field, which does not exist in Interchange's `BaseEnv`. The `env` passed to `createHarness` must include `directors: createDefaultDirectorRegistry()` (required by `BaseEnv`). Missing either of these causes `createHarness` to throw at agent launch time, leaving every workflow run stuck in its current state with zero token consumption.

### `packages/agents` (`@workbench/agents`)

Agent definitions, system prompts, custom directors, and the `InstanceEvent` → `ChatMessage` adapter. This package is the source of truth for all template content. At hub boot, `seedAgentTemplates(db)` reads the templates from this package and idempotently upserts one Interchange agent definition per template (Myra, Oat, Freddy, Walter, Loop, …) into the global tenant — re-boot is a no-op.

```
src/
  personal-agent/
    prompt.ts        — Myra system prompt
    definition.ts    — Myra agent definition
    director.ts      — Custom director filtering inbound senders
  granola/
    prompt.ts        — Oat system prompt
    definition.ts    — Oat agent definition
    director.ts      — Custom director filtering inbound senders
  firecrawl/
    prompt.ts        — Freddy system prompt
    definition.ts    — Freddy agent definition
    director.ts      — Default director
  adapter.ts         — InstanceEvent → ChatMessage adapter
  prompt-builder.ts  — Shared prompt formatting utilities
  index.ts           — Public exports
```

#### `prompt-builder.ts` exports

- `PromptFormat` — `'xml' | 'markdown'`
- `formatFromModel(model: string): PromptFormat` — returns `'xml'` for `claude-*` models, `'markdown'` for all others
- `buildSystemPrompt(sections: PromptSection[], format: PromptFormat): string`
- `buildContextBlock(context: Record<string, string>, format: PromptFormat): string`

### `packages/tools-*` — Tool Packages

Each tool package is self-contained and follows the same shape:

```
packages/tools-<name>/
  src/
    index.ts    — tool definitions, AgentTool handlers, *_HUB_TOOLS registry entry
  package.json
  tsconfig.json
```

Every tool package exports:

- `create<Name>Tools(config): AgentTool[]` — returns AgentTool handlers for use in an agent runtime
- `*_HUB_TOOLS: Record<string, ToolEntry>` — hub registry entries; spread into `KNOWN_TOOLS` in `apps/hub/src/lib/tool-registry.ts` to register

No tool package reads env vars or resolves credentials. Config (`apiKey`, `baseURL`) is always supplied by the caller.

**`packages/tools-exa`** (`@workbench/tools-exa`): Exa search API. Exports `EXA_HUB_TOOLS` with `exa_search` and a provider-agnostic `web_search` alias resolving to the same handler (providerName: `'exa'`). Both return normalized `ResearchItem[]` (`source: 'web'`); results without a publish date fall back to retrieval time tagged `provenance: 'degraded'` so they stay in-window but rank below dated, voted sources.

**`packages/tools-granola`** (`@workbench/tools-granola`): Granola notes API. Exports `GRANOLA_HUB_TOOLS` with `granola_list_notes`, `granola_get_note`, and `granola_list_folders` (providerName: `'granola'`). `granola_list_notes` paginates with `page_size` (default 10, max 30) and accepts `created_after`/`created_before`/`updated_after`/`folder_id` filters; `granola_list_folders` surfaces folder IDs for that `folder_id` filter.

**`packages/tools-firecrawl`** (`@workbench/tools-firecrawl`): Firecrawl v2 API. Exports `FIRECRAWL_HUB_TOOLS` with `firecrawl_scrape`, crawl start/status/active/errors/cancel/params-preview tools, batch scrape start/status/errors/cancel tools, `firecrawl_map`, `firecrawl_search`, extract start/status tools, `firecrawl_agent` (autonomous research via POST /agent), `firecrawl_parse` (document parsing), `firecrawl_interact`, `firecrawl_browser_sessions_list`, `firecrawl_browser_session_delete`, monitor CRUD (create/get/update/delete/list/run/check), `firecrawl_credit_usage`, `firecrawl_historical_credit_usage`, `firecrawl_token_usage`, `firecrawl_historical_token_usage`, and `firecrawl_activity` (providerName: `'firecrawl'`). Long-running endpoints return job IDs and require explicit polling tools.

#### last30days research workflow

The `last30days` research capability is split into per-source fetch tools, a deterministic core, and the `last30days-research` workflow (`workflows/last30days-research`). Inline inference steps use the workflow runtime's `createAgent` path and do not deploy idling per-step agents.

- **Source tools** each normalize their API into a shared `ResearchItem` (`{ url, title, publishedAt, source, engagement, author?, topComments? }`): `tools-hackernews`, `tools-github`, `tools-exa` (web), `tools-reddit` (`reddit_search`/`reddit_subreddit_search` via ScrapeCreators, passing through top comments when the payload carries them), `tools-x`, `tools-polymarket`, `tools-scrapecreators` (tiktok/instagram/threads/pinterest), `tools-youtube` (`youtube_search`, providerName `'youtube'`), and `tools-bluesky` (`bluesky_search`, unauthenticated public AppView — no credential).
- **`packages/last30days-core`** (`@workbench/last30days-core`): pure pipeline — `entityExtract`, `dateFilter`, `dedupe`, `clusterMerge`, `rankScore` (engagement + freshness + source-breadth + a capped top-comment "fun" bonus, minus a degraded penalty), and `buildReport`, which returns a typed, ArkType-validated `ResearchBrief`: `{ topic, days, queryType?, stats: { sourceCount, itemCount, dateRange? }, leadInsight?, clusters[], bestTakes[], items[], citations[] }`. `parseReport(unknown)` is the canonical boundary parser consumers use instead of re-declaring the schema.
- **`last30days_core_report`** returns the brief; the agent persists it via `write_artifact { kind: 'research', data: brief }`, which stores the structured brief at `artifact.source.brief` (and refreshes the parent row on a same-title/kind update so the gallery never shows a stale version). `apps/web` `ResearchBody` validates `source.brief` through `parseReport` and renders clusters, best-takes, stats, and citations; it falls back to markdown when no valid brief is present.

### `packages/chat` (`@workbench/chat`)

Transport-agnostic chat UI components. No dependency on a specific agent transport or WebSocket implementation.

## Naming Conventions

- **Files**: Lowercase, hyphens for multi-word (`pain-point.ts`, `session-service.ts`)
- **Factory functions**: `create*` prefix (`createSessionService`, `createPipeline`)
- **Predicates**: `is*` prefix (`isValidPainPoint`)
- **Retrieval**: `get*` prefix (`getSessionById`)
- **Handlers**: `handle*` prefix (`handleAnalyze`)
- **Variables**: `camelCase` for regular, `SCREAMING_SNAKE_CASE` for constants
- **ID generation**: Use `generateId` imported from `@intx/hub-common` — do not reimplement

## API Surface

### Agent Provisioning

| Method   | Route                                          | Input                                                                               | Output                           |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| `GET`    | `/agents`                                      | `?tenantId=...`                                                                     | `{ data: AgentInstance[] }`      |
| `DELETE` | `/tenants/:tenantId/credentials/:credentialId` | — (Interchange-native; manage grant created at write time)                          | `{ ok: true }` 200               |
| `POST`   | `/instances/:instanceId/sessions`              | `{}` (no credential IDs — Interchange resolves from agent's credentialRequirements) | `{ launched, launchError? }` 200 |

Agent launch does not accept credential IDs. The agent definition declares `credentialRequirements`; Interchange resolves them at launch time by walking the tenant ancestor chain. Grants written at credential-creation time are for management access only (delete/update via Settings UI), not for resolution.

All routes that trigger a session launch return `launched: boolean` and an optional `launchError` string. Launch failures are surfaced to callers; they do not cause the route to return an error status (the agent/credential record was still created). Session launch is retried up to 3 times with a 1 s delay before reporting failure.

**Tool-grant persistence**: at launch, `persistInstanceToolGrants` (`apps/hub/src/routes/agents.ts`) reconciles the instance principal's `tool:*` grant rows to `capabilities.tools` — deleting the principal's existing `origin: system` tool grants and re-inserting the current set via `buildToolGrantRows` (`apps/hub/src/lib/tool-grants.ts`). These rows are persisted (not synthesized in memory) so they survive sidecar reconnect; migration `0013_backfill_tool_grants.sql` backfills them for instances provisioned before this change. See ARCHITECTURE.md § Tool authorization.

### Workspace Creation

| Method | Route         | Input              | Output                                     |
| ------ | ------------- | ------------------ | ------------------------------------------ |
| `POST` | `/workspaces` | `{ name: string }` | `{ tenantId, tenantSlug, tenantName }` 201 |

Creates an Interchange tenant + seeds owner role/principal/grants for the caller. Idempotent by slug.

### Collateral Generation

| Method | Route                    | Input                                                           | Output                      |
| ------ | ------------------------ | --------------------------------------------------------------- | --------------------------- |
| `POST` | `/collateral-generation` | `{ inputArtifactIds: string[], outputTypes: CollateralType[] }` | `{ workflowId, artifacts }` |

Each `outputType` generates independently in parallel via `@intx/agent`. Results are stored as `artifact` rows with `kind = outputType` and `workflowId` FK.

### Workflow Deploy and Run Routes

Workflows run on Interchange's native runtime; the hub deploys definitions and observes runs (no hub-routed step state machine). See ARCHITECTURE.md § Native Workflow Runtime and [DEPLOYING_WORKFLOWS.md](../DEPLOYING_WORKFLOWS.md).

| Method | Route                                        | Input         | Output                                 |
| ------ | -------------------------------------------- | ------------- | -------------------------------------- | --------------------------------------------- |
| Method | Route                                        | Auth          | Input                                  | Output                                        |
| ------ | -------------------------------------------- | ------------- | -------------------------------------- | --------------------------------------------- |
| `POST` | `/api/internal/workflows/deploy`             | service token | serialized `@intx/workflow` definition | `{ kind, deploymentId, result }`              |
| `GET`  | `/api/v1/workflow-runs`                      | user session  | —                                      | `[{ deploymentId, kind, status, createdAt }]` |
| `GET`  | `/api/v1/workflow-runs/:deploymentId/stream` | user session  | — (SSE)                                | `data: { seq, runId, event: WorkflowEvent }`  |
| `POST` | `/api/v1/workflow-runs/:deploymentId/signal` | user session  | `{ runId, signalName, payload }`       | `202 { accepted: true }`                      |
| `GET`  | `/recent-calls`                              | user session  | `?tenantId&kind`                       | `{ calls }`                                   |

**Deploy** (`apps/hub/src/routes/workflow-deploy.ts`) — service-token-gated. Validates the posted definition, resolves the tenant deploy config, and runs the `@intx/workflow-deploy` orchestrator via `apps/hub/src/services/workflow-deploy.ts` (`createWorkflowDeployService` → `deployWorkflow`). The service writes `workflow.json` + `capability-declarations.json` to a git-backed `workflow` repo (`createWorkflowRepoWriter`), launches one session per step (`toLaunchSession` over `SessionService`), and sends the multi-step deploy frame to the sidecar (`toSendMultiStepDeploy` over `SidecarRouter`; the `as AgentDeployWorkflow['definition']` cast reflects only exactOptional variance — see AGENTS.md § Vendored workflow-host wiring). Pushed via the admin CLI's **Local actions → Push a workflow** (which spawns `apps/hub/bin/deploy-workflow.ts` internally; see [ADMIN_CLI.md](./ADMIN_CLI.md)), which imports `@workbench/workflow-<kind>`, serializes its `workflow`, and POSTs it with `HUB_SERVICE_TOKEN`.

**Run routes** (`apps/hub/src/routes/workflow-runs.ts`):

- `GET /api/v1/workflow-runs` — tenant index from the `workflow_run` table (`deploymentId IS NOT NULL`, non-deleted).
- `GET /api/v1/workflow-runs/:deploymentId/stream` — SSE over the run's native `WorkflowEvent` log via `subscribeKind(repoStore, principal, { kind: 'workflow-run', id: deploymentId }, ...)`. Emits the 17 on-disk event types (`RunStarted`, `StepStarted`, `StepCompleted`, `StepFailed`, `SignalAwaited`, `SignalReceived`, `RunCompleted`, `RunFailed`, `RunCancelled`, …).
- `POST /api/v1/workflow-runs/:deploymentId/signal` — HITL approval; delivers via `sidecarRouter.sendSignalDeliver` at `deriveDeploymentAddress(...)` (from `@intx/workflow-deploy`).
- `POST /api/v1/workflow-runs/:kind/start` — **not yet wired** (throws; run-start via mail is not yet implemented).

#### Workflow definition packages

Each kind is a package under `workflows/<kind>/` named `@workbench/workflow-<kind>`, exporting `kind` + `workflow` (`defineWorkflow` with per-step `defineAgent` and `awaitSignal` HITL gates). Shipped kinds: `collateral-generation`, `presentation-generation`, `resource-enrichment`, `seo-enrichment`, `reddit-opportunity-scanner`, `blind-ab-comparison`. The hub imports none of them — its only workflow imports are `@intx/workflow-deploy` (the orchestrator) and the `WorkflowDefinition` _type_ from `@intx/workflow`. Adding a kind is a new package + a `deploy-workflow.ts` push.

#### Web run console

`useWorkflowRunState(deploymentId)` and `useSignalWorkflow(deploymentId)` (`apps/web/src/hooks/use-workflow.ts`) subscribe to the SSE stream, accumulate `WorkflowEvent[]`, and reduce them into a `RunState` via `resumeFromLog` (`@intx/workflow`). `RunConsole` (`apps/web/src/components/RunConsole.tsx`) renders the `RunState` generically (step timeline, outputs, and an Approve button at any `awaiting-signal` step), kind-agnostic.

#### Sidecar workflow-host

The sidecar drives runs via the vendored workflow-host wiring (copied verbatim from interchange's reference sidecar — see AGENTS.md § Vendored workflow-host wiring):

- `apps/sidecar/src/workflow-host-wiring.ts` — constructs the workflow supervisor with host bindings (mail bus, signing keypair, RepoStore, subprocess spawner).
- `apps/sidecar/src/workflow-substrate-factory.ts` — builds the per-child substrate (read-only repo handle + IPC write-proxy back to the supervisor).
- `apps/sidecar/src/workflow-run-pack-client.ts` — pushes the workflow-run event pack to the hub after each supervisor write.
- `apps/sidecar/bin/workflow-child` — the child-process entrypoint.

Step execution (`createSidecarStepInvoker`) dispatches by the step agent's tags: a step tagged `workbench.stepKind: 'deterministic-tool'` (built by `deterministicToolStep` in `@workbench/agents`) routes to `runDeterministicToolStep`, which builds the step's tool runner via `buildStepTools` and calls the tool directly — no `createAgent`/reactor/inference; all other steps run the real agent harness via `createWorkflowStepInvoker`. See `docs/DEPLOYING_WORKFLOWS.md` § Deterministic (non-inference) steps for the authoring patterns, step-output shapes, and current selector-DSL limitations (no rename/templating selector, no `map`+deterministic dispatch) that keep gamma `render` and ab-compare `persist` as agents.

#### Supervisor restart re-establishment (CL-2221/2224/2225)

A multi-step supervisor's mail address is registered only in the hub's in-memory `addressIndex` at deploy time (`sidecar-handler.ts` `sendAgentDeploy`) and is never re-advertised by the sidecar on register/reconnect — supervisors never call `startSession`, so they are absent from `restoreSessions`. A hub restart or sidecar bounce therefore drops the address and a later run-start/signal hits `agent is unreachable`. The hub re-establishes it from its own durable state (no sidecar self-restore):

- `WorkflowDeployService.ensureDeploymentRoutable` (`apps/hub/src/services/workflow-deploy.ts`) — idempotent (no-op when `getRoutableAddresses()` already includes the address) and coalesced per `deploymentId`. On a miss it reads `workflow.json` back via `readWorkflowDefinition` (working-tree read; `writeTree` materialized the file on the durable data dir), rebuilds config for the **existing** `deploymentId` (`assembleWorkflowDeployConfig`), and re-sends **only** the supervisor frame via `buildSupervisorDeployFrame` → `sidecarRouter.sendAgentDeploy`. It deliberately does **not** drive `orchestrator.deployWorkflow`: that re-launches every step session, and a step's trivial-branch `provisionAgent` throws `Agent already exists` for the still-present steps (they self-restore on a sidecar restart / stay alive on a hub restart).
- `apps/hub/src/routes/workflow-runs.ts` — the run-start and signal handlers `await ensureDeploymentRoutable` before delivering, so a trigger/signal never dead-ends (returns 500 if re-establishment genuinely fails).
- `apps/hub/src/services/workflow-reconciler.ts` — `createWorkflowReconciler` re-establishes every active (non-deleted) `workflow_run` deployment on hub startup and on each sidecar `agent.reconnected`, single-flight-guarded (`reconcileAll` self-guards) and best-effort (a per-deployment failure is logged, never aborts the pass or the sidecar's reconnection).
- `deployMultiStep` (`apps/sidecar/src/workflow-host-wiring.ts`) is idempotent: a re-deploy of the same address whose `definitionHash` matches the live supervisor short-circuits (returns the existing principal pubkey, no second `workflow-child` spawn); a different definition for a live address fails closed (every redeploy mints a fresh `deploymentId`→address, so same-address-different-definition is a contract violation).

**Limitation — paused runs don't resume across a restart.** Within one supervisor lifetime an `awaitSignal` gate resumes normally on signal, but a run parked at `awaitSignal` when the supervisor process dies cannot be resumed: the child's self-discovery (`workflow-host/src/child/self-discovery.ts`) replays the full log into `runWorkflow`, which throws `RuntimeResumeUnsupportedError` for an `awaiting-signal`/`awaiting-timer`/`in-flight` step (`interchange/.../runtime/run.ts:244-257`), and the rejection is swallowed without a terminal event (`run-child.ts:460`) so the run wedges. The hub machinery above re-establishes the supervisor so new runs work and resume works end-to-end once the upstream runtime re-arms awaiting-signal steps on resume — tracked in **CL-2226**.

#### Sidecar deployment reclamation (CL-2231)

A deployment's sidecar footprint — the supervisor's working-copy `workflow-run` repo (`<SIDECAR_DATA_DIR>/workflow-runs/<slug>`) plus each step's agent-state repo (`<dataDir>/agents/<id>`) and session agent dir — was never reclaimed, so repeated redeploys (deployment churn) accumulated orphaned git repos until the volume hit `ENOSPC` by **inode exhaustion** (not bytes; ~69MB but thousands of files). Two parts close this, both sidecar-local and never mutating hub state (the hub is the immutable source of truth):

- **Undeploy reclaim** (`apps/sidecar/src/workflow-host-wiring.ts`): at deploy the supervisor map entry records its `ownedDirs` (workflow-run repo + per-step agent-state/agent dirs, all from the sidecar's own `getRepoDir`/`SIDECAR_DATA_DIR`); the `undeploy` hook `fs.rm`s them after `supervisor.shutdown()`. Best-effort, idempotent, multi-step only, never throws. Covers the case where the supervisor is still in the in-memory map (live undeploy / supersede).
- **Boot reconciler** (`apps/sidecar/src/boot-reconciler.ts`, wired in `apps/sidecar/src/index.ts` before `orchestrator.start()` so interchange's `restoreSessions` never re-establishes orphans): fetches the live set from the read-only hub endpoint `GET /api/internal/deployments/live` (`apps/hub/src/routes/internal-deployments.ts`, sidecar-token gated, mirrors the internal tools routes; shared schema in `packages/tool-credentials`), then prunes only dirs whose embedded `ses_<32hex>` deployment-id **token** is absent from the live set. Matching is on the token, not exact dir names, so every id form a live deployment produces (agent-state repo id, sanitized address, supervisor dir, workflow-run slug) is provably kept. **Fail-safe by construction**: any fetch error / non-200 / non-JSON / validation failure / empty-live-set-with-orphans deletes **nothing**; a dir with no extractable token is always kept; `cache`/`assets`/`.sidecar-signing` are never candidates.

Residual: *live* step-agents still re-establish on boot and get `Reconnection rejected by governance` (interchange `restoreSessions` re-advertises them; bounded, benign — steps are re-provisioned per run). The real cure is removing per-step deployed agents — the **CL-2232** spike (inline `@intx/agent` inference).

**Vendored-file hazard:** the undeploy-reclaim logic lives in `apps/sidecar/src/workflow-host-wiring.ts`, which is re-synced verbatim from interchange's reference sidecar wiring on every interchange pin bump (see AGENTS.md § Dockerfile Maintenance → vendored workflow-host wiring). Re-apply the reclaim block (and its `sanitizeAgentAddress` helper) after each re-sync; the `*-undeploy-reclaim.test.ts` suite guards it.

### Skill Library

| Method   | Route                              | Input                                                                          | Output                                      |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------- |
| `GET`    | `/skills`                          | `?tenantId=...`                                                                | `{ skills: SkillItem[] }` (access-filtered) |
| `GET`    | `/skills/share-targets`            | `?tenantId=...`                                                                | `{ targets: { tenantId, name }[] }`         |
| `GET`    | `/skills/:assetId`                 | `?tenantId=...`                                                                | `{ skill: SkillItem, files: SkillFile[] }`  |
| `GET`    | `/skills/:assetId/versions`        | `?tenantId=...&limit=&offset=` (limit default 20, max 100)                     | `{ versions: SkillVersion[], total }`       |
| `POST`   | `/skills`                          | JSON `{ name, text, description?, scope? }` or multipart files (`scope` field) | `{ skill: SkillItem }` 201/200              |
| `POST`   | `/skills/:assetId/restore`         | JSON `{ sha }`                                                                 | `{ skill: SkillItem }` 200                  |
| `DELETE` | `/skills/:assetId`                 | `?tenantId=...`                                                                | `{ ok: true }` 200                          |
| `POST`   | `/agents/:agentId/skills/:assetId` | `?tenantId=...`                                                                | `{ agentAsset }` 201                        |
| `DELETE` | `/agents/:agentId/skills/:assetId` | `?tenantId=...`                                                                | `{ ok: true }` 200                          |

**`SkillItem`**: `{ id, name, displayName: string | null, createdAt, updatedAt, scope: 'private' | 'tenant', accessTenantId: string, ownerUserId: string | null, ownerName: string | null }` — `name` is the kebab asset name; `displayName` is the human label; `scope`/`accessTenantId` describe sharing; `ownerName` is resolved by joining the `user` table on `owner_user_id`.

**`SkillVersion`**: `{ sha, shortSha, version, message, authorName, createdAt }` — `version` is the sequential number (v1 = oldest); `shortSha` is the 7-char git oid.

**`SkillFile`**: `{ path: string, content?: string }` — `content` is absent for binary files. `path` is relative to the `<assetName>/` prefix (e.g. `SKILL.md`, `examples/demo.md`).

**Access metadata** — hub-owned `skill_access` table (`apps/hub/src/db/schema.ts`, migration `0026`): `{ assetId (PK), scope, ownerUserId, ownerPrincipalId, createdAt }`. No FK to `asset` (Interchange-owned), so `deleteSkill` clears the row explicitly. Types are defined with arktype (`skillItemSchema`, `skillVersionSchema`, `skillAccessScopeSchema`).

**Service** — `apps/hub/src/services/skill-library.ts`:

- `buildSkillBundle(files)` — validates paths (path traversal rejection, junk file filter), enforces 20 MB / 200 file limits, picks an entrypoint (`SKILL.md` preferred), computes a content checksum
- `buildSkillTree(assetName, description, bundle, fileContents)` — maps bundle files to `<assetName>/` tree paths, synthesises YAML frontmatter for the entrypoint (required by Interchange's `skillKindHandler`)
- `isSkillVisible(row, viewer)` — pure access rule (ancestor-chain membership + tenant/legacy/private-owner); drives `listSkills`/`getSkillAsset` filtering
- `canManageSkill(row, actor)` — pure ownership rule for delete/update/restore: stable user id when an access row exists, else the creator principal (legacy). `loadManageableSkill` resolves the asset across the ancestor chain and applies it (404 not-visible, 403 not-owned)
- `listSkills`/`getSkillAsset` — take a `{ tenantId, userId }` viewer, join `skill_access` + `user`, filter via `getAncestorChain` + `isSkillVisible`
- `listShareTargets(db, userId, tenantId)` — ancestor tenants the user is an active member of, closest first
- `createSkill` — calls `AssetService.createAsset` then `populateAsset`, then writes the `skill_access` row; catches `AssetServiceError { reason: 'duplicate_asset' }` → `SkillLibraryError` (409)
- `toVersionEntries(commits)` / `listSkillVersions` — git log → absolutely-numbered version entries (v1 = oldest), paginated (`{ versions, total }`, newest first); `SkillDetail` pages with a "Show older versions" control. `excludeRepoInitCommit` drops Interchange's genesis `"Initialize repository"` commit so a fresh skill starts at v1, not v2
- `restoreSkillVersion` — reads the tree at a commit and re-commits it to `refs/heads/main` (creator-only)
- `getSkillContent` — `git.walk` over `refs/heads/main`; returns `undefined` from `map` for directories (descent) and `null` only to hard-prune; strips frontmatter from `SKILL.md` before returning
- `deleteSkill` — deletes `asset` row (cascades `agent_asset`) and the `skill_access` row, then `fs.rm` the git repo dir; logs but does not throw on fs failure

**Frontend** — `apps/web/src/hooks/use-skills.ts`:

All skill hooks live here (`useSkillLibrary`, `useSkillDetail`, `useCreateSkill`, `useDeleteSkill`, `useSkillShareTargets`, `useSkillVersions`, `useRestoreSkillVersion`). `use-workflow.ts` re-exports them for backward compatibility. ArkType schemas validate API responses at the boundary; `useCreateSkill` threads the chosen `scope`.

**Detail page** — `apps/web/src/pages/SkillDetail.tsx`:

- Builds a `TreeNode` tree from the flat `files` array; renders a collapsible sidebar tree with `TreeItem`
- Auto-selects the first file (`selectedPath ?? files[0]?.path`)
- Renders `SKILL.md` through `react-markdown` with a source/preview toggle (bottom-left corner)
- Version-history panel (`useSkillVersions`): newest-first list with `v{n}`, short sha, author, date; current version flagged, others offer Restore via `useRestoreSkillVersion`
- Inline delete: "Delete" → confirm/cancel buttons → `mutateAsync` → navigate to `/skills` on success; surfaces errors inline without swallowing them

**Upload page** — `apps/web/src/pages/SkillsNew.tsx`: when `useSkillShareTargets` returns more than one tenant, a "Who can access this skill?" radio set lets the user pick which one; with a single target the chooser is hidden and that tenant is used. Create is always `scope: 'tenant'` with the selected `tenantId`. (The "Just Me"/`private` path was dropped pending a personal-tenant story; the backend `private` scope remains unused.)

**Library page** — `apps/web/src/pages/SkillsLibrary.tsx`: cards show owner, last-edited date, and an access label (`Private` or the resolved share-target tenant name).

**Routing** — `/skills` (library), `/skills/new` (upload form), `/skills/:id` (detail + delete)

### Health

| Method | Route     | Output                              |
| ------ | --------- | ----------------------------------- |
| `GET`  | `/health` | `{ status: "ok", service: string }` |

## Database Schema

### Artifacts

The `artifact` table is the single store for all workflow and agent outputs.

- `id` (UUID, primary key)
- `kind` (CollateralType enum: case-study, one-pager, email-draft, call-document, ...)
- `sessionId` (UUID, foreign key, **nullable** — workflow-level artifacts have no session)
- `workflowId` (UUID, foreign key, nullable — links to a `workflow_run` for run-scoped artifacts)
- `content` (text)
- `createdAt` (timestamp)

### Workflow Run (`workflow_run`)

The generic, kind-agnostic run row. For natively deployed workflows it is the hub-side index into Interchange's native run; run state itself lives in the native `workflow-run` event log, not here.

- `id` (UUID, primary key)
- `deploymentId` (text, nullable) — the `@intx/workflow-deploy` deploymentId (`ses_…`) for natively deployed runs; null for legacy pipeline-session rows. The `GET /api/v1/workflow-runs` index filters on it
- `tenantId` (text), `principalId` (text)
- `kind` (text) — workflow kind
- `status` (text), `input` / `output` (jsonb, nullable)
- `createdAt`, `updatedAt`, `deletedAt` (timestamps)

### Enabled Workflows (`enabled_workflow`)

Tracks which workflow kinds a principal has enabled in a tenant.

- `id` (text, primary key)
- `tenantId` (text)
- `principalId` (text, NOT NULL) — the enabling member's principal
- `kind` (text) — workflow kind
- Unique `(tenant_id, principal_id, kind)` for idempotent upserts. Scoped per-principal so one member's enablement cannot overwrite another's in the shared global tenant.

### Migration Sequence

| Migration     | Description                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0020_upload` | Adds the `upload` table (`id`, `tenant_id`, `principal_id`, `filename`, `mime_type`, `content` BYTEA, `size`, `created_at`) for pre-workflow binary files (xlsx) that arrive before a run exists |

> The native-runtime cutover added the `workflow_run.deployment_id` index column and removed the deleted custom-stack tables (`collateral_generation_workflow`, `workbench_user`) and the `workbench_workflows.assignments` column. See `apps/hub/migrations/` for the current sequence.

## Agent Architecture

### Credentials and Grants

#### Credential sources by agent

- **Personal agent (Myra)**: `source: 'tenant'`, `name: 'Myra LLM'` for openai-compatible inference — resolved down the global org tenant's ancestor chain (org-level or per-workbench). The credential is stored tenant-owned (`principalId: null`) and created during onboarding. Each user has their own Myra agent definition in the global tenant, keyed on `(tenantId, creatorPrincipalId)`.
- **Granola agent (Oat)**: `source: 'tenant'` for both `granola` and `openai-compatible` — resolved against the workspace tenant

#### Creating credentials

Credentials are created by an org admin via **`@intx/admin-ui`** using Interchange's native `POST /api/tenants/:tenantId/credentials` route. The workbench product app has no credential creation UI.

**Credentials are always tenant-owned** (`principalId: null`). This is required for Interchange's `source: 'tenant'` resolution to find them at agent launch time.

Secrets are stored as plaintext at the application layer; encryption is handled at rest by the storage layer. The app reads secrets directly from the `credential` table and passes them to the sidecar without any decryption step.

For local dev, seed providers and credentials from env vars via the admin CLI's **Local actions → Seed tool credentials from env** (see Local Development).

#### What must not change

- **Do not `void` the call inside the reconnect listener.** `emitAndAwait` awaits the promise the listener returns. `void` detaches the async body, destroying the sequencing guarantee and causing the push to race with (and likely lose to) Interchange's encrypted push.
- **Do not reorder listener registration.** Our listener must be registered after `createHubSessionOrchestrator`.
- **If you add a new caller of `sidecarRouter.sendSourcesUpdate`**, verify it sends the credential secrets as read from the `credential` table (plaintext; no decrypt step required).

The reconnect bug has been fixed.

#### Credential verification (ancestor-chain lookup)

> **Interchange-provided**: `getAncestorChain` is exported from `@intx/db` (`interchange/packages/db/src/credential-resolution.ts`). The workbench calls it; it is not reimplemented.

When verifying credentials at provisioning or session-launch time, the hub calls `getAncestorChain(db, tenantId)` to walk the Interchange tenant hierarchy up to the root, then checks `credential.tenantId IN (chain)`. This allows a credential in a parent tenant to be granted to an agent in a child tenant, matching Interchange's authz model.

#### Provisioning an agent with credentials

The workbench does **not** pass credential IDs at agent launch time. Interchange resolves credentials from the tenant automatically using the agent's `credentialRequirements`.

When provisioning an agent, the hub:

1. Creates the agent definition with `credentialRequirements` declaring what the agent needs (e.g. `[{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }]`).
2. Creates the agent instance (**Interchange**: uses Interchange's `agent`, `agentInstance`, `tenant`, `principal` tables from `@intx/db`).
3. Launches the session via `sessionService.launchSession` — Interchange's `resolveCredentialRequirement` walks the tenant hierarchy and builds `InferenceSource[]` from the agent's requirements. No credential IDs are passed to this call.

**No credential IDs in launch calls.** Credentials live on the tenant. The agent declares what it needs. Interchange finds them.

The `grant` table is still used for one purpose: giving the creating principal manage access to the credential record so the Settings UI can delete/update it (`resource: credential:{id}`, `origin: creator`, `principalId: callerPrincipal.id`). This is a management grant, not a resolution grant.

#### Credential picker (frontend)

> **Custom workbench UI** over Interchange data. The `listTenantCredentials` call hits Interchange's `/api/tenants/:tenantId/credentials` (mounted by `createApp` from `@intx/hub-api`) — the workbench does not re-implement the list/read endpoints.

The `useCredentials` hook (`apps/web/src/hooks/use-credentials.ts`) fetches the caller's accessible principals via `getMyPrincipals()` (**Interchange**: `/api/me/principals`), then fetches credentials per tenant via `listTenantCredentials(tenantId)` (**Interchange**: `/api/tenants/:tenantId/credentials`). Returns `{ principals, credentialsByTenant, isLoading }`.

The `CredentialPicker` component (`apps/web/src/components/CredentialPicker.tsx`) renders a checkbox list displaying each credential as `"{cred.name} — {tenantName}"`. It receives the full `credentialsByTenant` map — not filtered to a single workspace — so credentials from parent tenants are visible and selectable (matching the ancestor-chain grant model).

#### Route mounts

**Interchange-owned routes** (mounted automatically by `createApp` from `@intx/hub-api`, available at `/api/tenants/:tenantId/*`):

- `GET /api/tenants/:tenantId/credentials` — list credentials (used by frontend)
- `GET /api/tenants/:tenantId/principals` — list principals
- `GET /api/tenants/:tenantId/grants` — list grants
- All other tenant/principal/grant CRUD

**Workbench-owned routes** (in `apps/hub/src/routes/`, mounted under `/api/v1/`):

- `DELETE /api/tenants/:tenantId/credentials/:credentialId` — Interchange-native (manage grant created at write time enables this)
- `POST /v1/instances/:instanceId/sessions` — launch session for existing instance (no credential IDs; Interchange resolves from agent's credentialRequirements)
- `POST /v1/workspaces`, `GET /v1/agents`, etc.

**Internal routes** (sidecarToken auth, mounted under `/api/internal/`):

- `POST /api/internal/approvals` — human approval callback from sidecar (ask_principal tool)
- `POST /api/internal/tools/run` — hub-proxied tool execution. Body: `{ tenantId, toolName, args }`. Hub resolves the tenant credential for the tool's provider from Interchange, calls the tool package handler, returns `{ result: string, isError: boolean }`. Credentials are decrypted before use; never stored in sidecar.

### Deploy Prompts

Agent deploy prompts are currently **static** (no dynamic context injected at deploy time). Dynamic context (current date, operator name, etc.) will be injected at session start via the hub-client layer — not yet implemented.

### Session Liveness and Relaunch

An instance is reachable for mail only when its row `status` is `running` — Interchange's session orchestrator sets this when the agent's session connects, and the mail route (`POST /tenants/:tenantId/agents/instances/:instanceId/mail`) returns `409` (`Instance is not running`) for any other status.

A hub or sidecar restart drops the in-memory agent — the sidecar re-registers "with 0 agents" — but leaves the DB rows behind: `agentInstance.status` stays `deployed` and the old `agentSession` row stays `active`. The session record is therefore **not** a reliable liveness signal across restarts.

`relaunchInstanceIfNeeded` (`apps/hub/src/routes/agents.ts`, called from `GET /v1/me`) gates on the live instance status, not the stale session record: it returns early only when `instance.status === 'running'`, and otherwise relaunches (subject to the tenant having an active credential). This is what brings Myra back automatically after a deploy or crash — without it, every `/mail` POST kept 409ing on a restarted instance.

The Myra chat (`apps/web/src/components/PersonalAgentChat.tsx`) also self-heals at send time: if `sendMail` throws an `ApiError` with status `409`, it calls `launchInstanceSession(instanceId)` and retries the send once. This covers the window between a restart and the next `/v1/me` relaunch, so a send during that gap heals rather than throwing and dropping the message. A genuine failure surfaces the recoverable error notice instead of crashing the panel.

#### Disconnect reconciler

Interchange's session orchestrator only abandons the in-memory event collector on `sidecar.disconnect`; it leaves `agentSession.status = 'active'` so a transient reconnect can resume. When a sidecar fully restarts (every redeploy) the previous address never re-registers, so the DB is left describing a live agent that no sidecar routes — and `relaunchInstanceIfNeeded` then returns early forever (an active session reads as "the harness owns it"), wedging the instance until its row is deleted by hand.

`registerDisconnectReconciler({ db, router })` (`apps/hub/src/routes/agents.ts`, wired in `apps/hub/src/index.ts` after `createHubSessionOrchestrator`) subscribes to `sidecar.disconnect`. For each disconnected address it waits a grace window (`DEFAULT_DISCONNECT_RECONCILE_GRACE_MS`, 90s — the host's bet on how long a genuine reconnect can take) and then calls `reconcileDisconnectedSession`. That function re-checks `sidecarRouter.getRoutableAddresses()`: if the address is routable again the sidecar reconnected and there is nothing to do; otherwise the agent is gone, so its non-`ended` session is marked `ended` (`status`, `endedAt`, `updatedAt`). Ending the stale session lets the next `relaunchInstanceIfNeeded` treat the instance as a cold start — so Myra auto-relaunches via `/v1/me` and other agents recover on next open, instead of staying wedged behind a phantom session.

## Environment Configuration

All environment validation lives in `apps/hub/src/config.ts`. Variables are validated at startup via `requireEnv()` — no silent defaults for required values.

`loadConfig()` sets a module-level singleton; `getConfig()` returns it. Library modules that need config values import `getConfig()` directly — they do not reach into `process.env` themselves. This keeps validation in one place and makes config access testable via `mock.module('../config', ...)`.

### Added Variables

| Variable               | Required | Purpose                                                                                         |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `GLOBAL_TENANT_SLUG`   | Yes      | Slug of the shared global org tenant, seeded at hub boot. Deployment-specific, never hardcoded. |
| `GLOBAL_TENANT_NAME`   | Yes      | Display name of the global org tenant (e.g. the org's name for this deployment).                |
| `GLOBAL_TENANT_DOMAIN` | Yes      | Domain of the global org tenant; Myra instance addresses are `instanceId@<domain>`.             |

## Authentication

### Google OAuth Configuration

Google OAuth is required for all users. Configuration:

- **Client ID / Secret**: Configured via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.workbench`
- **Redirect URI**: `http://localhost:5174/auth/callback` (local) or production equivalent
- **Domain Allowlist** (optional): `GOOGLE_ALLOWED_DOMAINS` — comma-separated domains (e.g., `example.com,partner.com`). If set, only users with email addresses in these domains can authenticate. If unset, any Google account is allowed.
- **Session Handling**: Sessions are stored in secure, HTTP-only cookies with CSRF protection.
- **Trusted Origins**: The API whitelists CORS origins via `TRUSTED_ORIGINS` (comma-separated).

## Local Development

### Infrastructure

```bash
docker compose up -d
```

Services:

- PostgreSQL on `localhost:5433`
- MinIO on `localhost:9000` (API) and `localhost:9001` (console)

### Environment

```bash
cp .env.example .env
# Edit required values
```

Per-instance env files are also provided for running services independently:

- `.env.hub.example` → `.env.hub` — hub-specific variables
- `.env.sidecar.example` → `.env.sidecar` — sidecar-specific variables
- `.env.migrate.example` → `.env.migrate` — migration-only variables

To seed providers and credentials locally, copy your API keys into the appropriate env file, then run the admin CLI (`bun run admin`), select the tenant, and choose **Local actions → Seed tool credentials from env**.

This reads `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY` (or `GEMINI_API_KEY`), `GRANOLA_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `BROWSERBASE_API_KEY` (+ `BROWSERBASE_PROJECT_ID`), `XAI_API_KEY`, `SCRAPECREATORS_API_KEY`, `GAMMA_API_KEY`, `GITHUB_API_KEY`, and `YOUTUBE_API_KEY` and upserts the corresponding providers and tenant credentials. For Google Gemini it creates provider `google-genai`, reconciles `metadata.baseURL` on existing tenant-owned provider rows, and upserts credential **`google-ai`** (overridable via `GOOGLE_AI_CREDENTIAL_NAME`) with `metadata.model` from `GOOGLE_AI_MODEL` (default `gemini-3.1-flash-lite`). That model env var is stored on the credential only; SEO enrich uses the workflow `defaultModel`, not the env var. The `buildEntries()` function is the single list of seeded providers; each entry is skipped silently when its key is unset.

`add-llm-credential.ts` also upserts `google-ai` when a Gemini key is set, but does not patch stale provider metadata on existing `google-genai` rows — use `seed-credentials.ts` when upgrading SEO enrich or fixing a misconfigured provider base URL.

Production seeding requires `HUB_URL`, `GLOBAL_TENANT_SLUG`, and either `SESSION_TOKEN` (OAuth-only) or `SUPERADMIN_EMAIL` / `SUPERADMIN_PASS`. See [`DEPLOY.md`](../DEPLOY.md) Step 5.

**Adding a credentialed tool:** when a new `@workbench/tools-*` package declares a credential `providerName`, you must add a matching entry to `buildEntries()` in `apps/hub/bin/seed-credentials.ts` (reading a `*_API_KEY` env var) and list that env var in `.env.example`, or the tool will resolve no credential in deployed environments and return nothing. Keyless tools (e.g. the public Bluesky AppView) need no entry.

### Running

```bash
# All services in parallel
bun run dev

# Or individually
bun run --filter @workbench/hub dev
bun run --filter @workbench/web dev
```

## Build Pipeline

```bash
bun run format    # Prettier
bun run lint      # ESLint + docs freshness
bun run check     # tsc -b --noEmit
bun run test      # bun test
```

Or via `make all` if Makefile is available.

## Railway Deployment

The workbench deploys as three separate Railway services from the same repo. This is a **shared monorepo**: every service builds with the repo root as its Docker build context (Root Directory `/`), because they all depend on the shared lockfile, `packages/*`, and the vendored `interchange/packages/*` workspaces.

### Services

| Service | Config file                 | Dockerfile                | Purpose                                 |
| ------- | --------------------------- | ------------------------- | --------------------------------------- |
| Hub     | `apps/hub/railway.toml`     | `apps/hub/Dockerfile`     | Hono API, DB migrations                 |
| Web     | `apps/web/railway.toml`     | `apps/web/Dockerfile`     | Static SPA (Vite build served by Caddy) |
| Sidecar | `apps/sidecar/railway.toml` | `apps/sidecar/Dockerfile` | Interchange sidecar, agent lifecycle    |

Per Railway's monorepo model, the config file does **not** follow the Root Directory — set each service's Config-as-Code path to the absolute repo-root path (e.g. `/apps/hub/railway.toml`). `dockerfilePath` inside each config is relative to the build context (repo root). Each config declares `watchPatterns` so a service redeploys only when its own code or shared dependencies change.

### Dockerfiles

The hub and sidecar Dockerfiles follow the same pattern:

1. **Builder stage** (`oven/bun:1.3-alpine`): fetches and verifies `interchange/` from GitHub at a pinned commit + SHA256, installs workspace dependencies, builds the app
2. **Runtime stage** (`oven/bun:1.3-slim`): copies only what is needed to run

The pinned `INTERCHANGE_COMMIT` and `INTERCHANGE_SHA256` args must be updated together across all three Dockerfiles whenever interchange is upgraded.

`apps/sidecar/Dockerfile` builds nothing and runs directly from TypeScript source via `bun run`. `apps/web/Dockerfile` runs `vite build` in the builder stage and serves the static output via Caddy with an SPA fallback to `index.html`; it runs no Node/Bun process at runtime.

### Volumes

Both services require a **persistent volume** mounted in the Railway dashboard.

| Service              | Mount path | Env var                  | Contents                          |
| -------------------- | ---------- | ------------------------ | --------------------------------- |
| Sidecar              | `/data`    | `SIDECAR_DATA_DIR=/data` | Per-agent git repos, key pairs    |
| Hub (if self-hosted) | `/data`    | `HUB_DATA_DIR=/data`     | Agent repo mirrors, signing state |

### Sidecar Environment Variables

| Variable           | Description                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `HUB_WS_URL`       | WebSocket URL of the Interchange hub (e.g. `wss://hub.example.com/api/sidecars/ws`)                |
| `SIDECAR_ID`       | Stable opaque identifier for this sidecar instance (e.g. `gtm-staging`). Any slug format is valid. |
| `SIDECAR_TOKEN`    | Auth token for hub registration                                                                    |
| `SIDECAR_DATA_DIR` | Path on the persistent volume (e.g. `/data`)                                                       |

## Agent Runtime and LLM Inference

All LLM inference uses `@intx/agent` from `interchange/packages/agent`. The agent runtime provides:

- **Unified inference interface** across OpenAI, Anthropic, Google GenAI, and OpenAI-compatible endpoints
- **Configuration management** via `InferenceSource` (model, API key, base URL, provider)
- **Error handling and logging** with classified error types and structured output
- **Conversation history persistence** via pluggable context stores (isogit by default, in-memory for ephemeral tasks)
- **Tool execution framework** for agent-driven workflows

### Using `@intx/agent` for LLM Inference

**Single-call inference** (extraction, analysis, one-shot generation):

1. Create an `InferenceSource` from environment variables:

   ```typescript
   import type { InferenceSource } from '@intx/types/runtime';

   const source: InferenceSource = {
     id: `my-task-${id}`,
     provider: 'openai',
     baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1',
     apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
     model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
   };
   ```

2. Create a temporary agent with an ephemeral context directory:

   ```typescript
   import { createAgent } from '@intx/agent';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { randomUUID } from 'node:crypto';

   const contextDir = join(tmpdir(), `task-${randomUUID()}`);
   const agent = await createAgent({
     contextDir,
     sources: [source],
     defaultSource: source.id,
     systemPrompt: 'Your system instructions...',
     tools: [],
     closeTimeoutMs: 1000,
   });
   ```

3. Send your prompt and extract the response:

   ```typescript
   const result = await agent.send(userMessage);
   await agent.close();

   const data = JSON.parse(result.reply);
   ```

### Granola API v1 Integration

When configured with `GRANOLA_API_KEY`, Oat ingests recent sales calls from Granola's public API:

- **Endpoints**: Granola API v1 `GET /v1/notes` (list), `GET /v1/notes/{id}?include=transcript` (single note), and `GET /v1/folders` (list folders). The base URL is owned by the tool package (`GRANOLA_DEFAULT_BASE_URL`)
- **Pagination**: `page_size` query parameter (default 10, max 30) plus a `cursor`. Note titles may be `null`
- **Filters**: list-notes accepts `created_after`, `created_before`, `updated_after`, and `folder_id`. The scheduler client (`apps/hub/src/lib/granola.ts`) uses `created_after` to fetch only notes newer than the last poll rather than over-fetching and filtering in memory
- **Authentication**: Bearer token via `GRANOLA_API_KEY`
- **Integration**: Call recordings are fetched and stored as call document artifacts (kind: `call-document`) in the `artifact` table
- **Scope**: Entirely optional; Oat runs continuously and surfaces calls automatically

## UI Components

### Run Console (`RunConsole`)

Located in `apps/web/src/components/RunConsole.tsx`. A single generic console that renders any workflow run from its native event stream — there is no per-kind page or step registry (the bespoke `StepSidebar` + `buildSteps` step model was removed in the native-runtime cutover).

**Behavior:**

- Subscribes to the run's SSE event stream via `useWorkflowRunState(deploymentId)` and reduces it into a `RunState` with `resumeFromLog`
- Renders the step timeline with phase indicators (running / completed / failed / awaiting-signal) derived from the reduced `RunState`
- Shows step outputs as they arrive
- Renders an Approve button on any step whose phase is `awaiting-signal`, wired to `useSignalWorkflow` (HITL approval = a signal)

### Page Transitions

**Panel animations** (within a page):

- Left panels animate in from left: `x: -40, opacity: 0` → `x: 0, opacity: 1`
- Right panels animate in from right: `x: 40, opacity: 0` → `x: 0, opacity: 1`
- Spring transition: `type: 'spring', stiffness: 300, damping: 30`
- Staggered delays: left panel 0.1s, right panel 0.15s
