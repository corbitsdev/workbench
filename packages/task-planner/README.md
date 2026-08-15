# @corbits/task-planner

Myra auto-dispatch (CL-6051): a person types an outcome, Myra (the bench
default agent) is asked to turn it into a validated plan — either "use this
existing agent" or "create a new one with these tools/skills" — and that
plan is dispatched exactly like a manually-launched task.

## What this package owns

- **Inventory assembly** (`./src/inventory.ts`) — `assembleInventory` builds
  the compact, JSON-serializable `PlannerInventory` that rides inside the
  planner prompt: every conversational agent, usable tool package, skill,
  and catalog model the requesting principal is allowed to reference, plus a
  `memoryAvailable` fact. Every source is a host-injected `InventorySources`
  lister — this package owns the shape and the assembly, never the listing
  logic (a tenant's usable agents, tool packages, skills, and models are
  each already owned by another package). Memory folds into
  `listUsableToolPackages`'s responsibility (the host's implementation only
  includes the memory tool package entry when `memoryAvailable` is true) but
  is also surfaced as its own top-level fact so the prompt can reason about
  it directly.
- **`TaskSpec` schema + fail-closed validation** (`./src/task-spec.ts`) —
  `parseTaskSpec` reads Myra's reply as untrusted model output (arktype at
  the boundary, exactly like a request body) and throws
  `PlannerReplyUnparseableError` on anything that isn't valid JSON matching
  the `{use, refinedOutcome}` / `{create, refinedOutcome}` union.
  `validateTaskSpecAgainstInventory` then asserts every reference a
  validated-shape spec makes — an agent id, tool package names, skill
  names, a model name — actually appears in the inventory that was offered,
  throwing `PlannerReferenceOutOfInventoryError` on the first violation.
  Neither function partially trusts a near-miss. `kind: "task"` is a
  discriminant reserved for CL-5917 (routine chains, not yet built) to add
  a `"chain"` variant additively — the validation/dispatch PATTERN this
  package proves out is what CL-5917 reuses, never this schema directly; a
  chain is a materially different shape (an ordered sequence of
  `TaskSpec`-like steps, not one), so `kind` exists to let a future union
  branch land without reshaping this one, not to imply the schema itself
  is meant to grow into chains.
- **The one-shot reply wrapper** now lives in `@corbits/folded-runs`
  (`packages/folded-runs/src/one-shot-reply.ts`) — `runOneShotFoldedPrompt`
  launches a folded run, sends one prompt, and resolves a promise with the
  accumulated `connector.reply` content once the run's `message.run.ended`
  bracket closes (or rejects with
  `FoldedRunFailedError`/`FoldedRunTimedOutError`). It was promoted out of
  this package (CL-6051 finding 12) once CL-5917's routine chains needed the
  same primitive without depending on this package's `TaskSpec`; this
  package re-exports it from `./src/index.ts` for its own callers'
  convenience. No precedent for this shape existed elsewhere in the
  codebase before it — `@corbits/tasks`' own `launchTask` returns as soon as
  the run launches; this is the one place that turns the sidecar's
  `agent.event` stream into an awaitable promise, for a caller with no
  Inbox and no task row to hang an async delivery on.
- **Planner-run orchestration** (`./src/planner-run.ts`) — `runPlanner`
  resolves Myra's own definition for the tenant, assembles the inventory,
  builds the strict-output prompt, runs it, and parses + validates the
  reply. Every failure mode (Myra unresolvable, the run timing out or
  failing, an unparseable reply, an out-of-inventory reference) propagates
  as its own honest, specific error — this is the fail-closed core the
  whole feature's safety rests on.
- **Spawn dispatch** (`./src/spawn.ts`) — `spawnFromTaskSpec` dispatches a
  validated `TaskSpec` exactly the way a manually-launched task is
  dispatched: `{use}` calls `@corbits/tasks`' `launchTask` directly;
  `{create}` first re-validates `spec.create` through
  `@corbits/agent-directory`'s own `CreateAgentDefinitionInput` bounds
  (plus this package's own `toolPackagePins` cardinality+dedup bound,
  `./src/create-bounds.ts` — the REST boundary has no field for that
  pin), checks a `workflow-definition:*`/`create` grant
  (`requireDefinitionCreateGrant`), resolves each pin's `CredentialBinding`
  from the same inventory the plan was validated against, and only then
  deploys a brand-new agent definition (via the host-injected
  `deployAgentDefinition`, which wraps `@corbits/agent-directory`'s
  sanctioned deploy path) before launching against the result. Both
  branches link the launched task back to the planner run that chose its
  agent (`TaskStore.linkPlannerRun`) before returning. Any `launchTask`
  failure propagates unchanged.
- **Planner-created agent naming** (`./src/planner-created-naming.ts`) —
  every `{create}`-branch definition deploys under a
  `myra-task-<slug>-<8hex>` handle. `isPlannerCreatedDefinitionName` is
  excluded from LISTING/PICKER surfaces only — chat's invite/new-chat
  pickers and this package's own `listConversationalAgents` inventory
  source (both composed with the base taskability predicate as
  `isPickerListableDefinition` in `apps/hub/src/index.ts`) — and NEVER
  from the taskability/launchability gate itself: a planner-created
  agent exists for exactly one task and must stay fully launchable
  (`spawnFromTaskSpec` immediately launches against the definition it
  just created), so it is invisible in every picker while remaining
  reachable through the task record it belongs to — "View run", not a
  picker entry.
- **`createPlannerRoutes`** (`./src/routes.ts`) — `POST /`, tenant-scoped,
  `requireGrant`-gated, personal to the requesting principal (a planning
  prompt is a person's own, exactly like a task prompt). Depends on an
  injected `dispatch` port rather than calling `dispatchWithPlanner`
  directly, mirroring `@corbits/tasks`' own routes-depend-on-a-port shape.
  Every fail-closed planning error (Myra unresolvable, run timeout/failure,
  unparseable reply, out-of-inventory reference) maps to the same
  plain-language 422: "Myra couldn't turn that into a task. Try
  rephrasing, or pick an agent yourself." Anything else is a platform
  fault, re-thrown for the host's own error handling.
- **`dispatchWithPlanner`** (`./src/index.ts`) — the top-level convenience
  composing `runPlanner` then `spawnFromTaskSpec`.

## What the host must inject

- `InventorySources` (`listConversationalAgents`, `listUsableToolPackages`,
  `listSkills`, `listModels`, `memoryAvailable`) — the tenant ∩ credentials
  listers this package generalizes the pattern from (see
  `@workbench/connections`' `CONNECTOR_REGISTRY` and `@corbits/chat`'s
  `listConnectedProviders` for the closest existing precedent), plus
  `@corbits/skills`' `SkillRegistry.list` and the tenant's
  `GET /api/tenants/:tenantId/catalog/models` route.
- `resolveMyraDefinitionId(tenantId)` — `resolveMyraDefinitionIdFromDb(db,
tenantId)` is provided as the production implementation: it queries
  `workflowDefinition` by `name === "assistant"` (Myra's seeded asset name,
  resolved from `@corbits/workflow-catalog`'s `WORKFLOW_CATALOG`) and
  `tenantId`, mirroring `@corbits/tasks`' own `launchTask` definition
  lookup — same idea, keyed on `name` instead of `id`, since there is no
  "current tenant's Myra" foreign key anywhere else to join through.
- `OneShotRunnerDeps` (`foldedRuns: FoldedRunsDeps`, `events:
SidecarEventEmitter`, `cryptoProviders: CryptoProviderCache`, `undeploy:
  (address, reason) => Promise<void>`, `lifecycle?:
  Pick<AgentLifecycle, "track" | "recordActivity" | "untrack">`) — the same
  `foldedRuns`/`events`/`cryptoProviders` deps `@corbits/tasks`' launcher
  and orchestrator already take, plus the raw termination port a one-shot
  run tears itself down through the moment it settles (it has no further
  purpose after that, unlike a launched task, so it is never left for an
  idle sweep).
- `deployAgentDefinition` — a host-injected wrapper around
  `@corbits/agent-directory`'s sanctioned deploy path
  (`buildAgentDefinitionWorkflow` → `AssetService.createAsset` +
  `populateAsset` → `ensureWorkflowDefinitionForAsset`, plus
  `reindexPinnedSkills` when skills are present). Takes the handle
  `spawnFromTaskSpec` already derived (via `plannerCreatedDefinitionHandle`)
  and the `CredentialBinding[]` it already resolved from the inventory —
  never derives either itself. This package never reimplements that path
  in parallel.
- `requireDefinitionCreateGrant({tenantId, principalId})` — checked only
  on the `{create}` branch, before `deployAgentDefinition`; the
  production implementation calls `@intx/authz`'s `authorize` directly
  against `workflow-definition:*`/`create`, the same grant store and
  condition registry every other `requireGrant` call site in
  `apps/hub/src/index.ts` uses.
- `taskLauncherDeps: TaskLauncherDeps` and `store: TaskStore` — the same
  objects `@corbits/tasks` itself takes, unchanged.
- `requireGrant` (for the routes) — the same `createRequireGrant(...)`
  factory every other tenant-scoped route package takes.

## What this package never imports

- Nothing under `vendor/intx/**` directly — every platform capability
  arrives through `@corbits/folded-runs` and `@intx/*` published surfaces,
  the same seam `@corbits/tasks` and `@corbits/chat` use.
- No UI package.
- **Not a parallel agent-deploy implementation.** The `{create}` branch
  never hand-rolls asset creation — it calls into
  `@corbits/agent-directory`'s one sanctioned path via the host-injected
  `deployAgentDefinition`.
- **Deliberately bypasses `@corbits/tasks`' own `launchTask` for its own
  one-shot planning prompt.** A planner run is not a task: it gets no
  `task` row and never appears in the Inbox — only the FINAL spawned agent
  run does, via `spawnFromTaskSpec` → the real `launchTask`. The planner
  run's own durable record is the `workflowRun` row `launchFoldedRun`
  itself persists, addressable by `plannerRunId` (the run's own id) — this
  package persists nothing of its own beyond that, and owns no migration:
  it rides `@corbits/tasks`' `task.plannerRunId` column entirely.
