# @corbits/tasks

Spawn-and-return agent tasks: a person picks an agent definition, writes a
prompt, and a one-shot folded run launches on its own — no channel, no
participants, no settings. When the run finishes, its reply lands in the
Inbox as a `task-result` item (reply text, artifact chips, agent name,
elapsed time, a "View run" link) and the run goes back to sleep through the
same idle-sleep lifecycle chat already uses.

## What this package owns

- **`task` table** (`./src/schema.ts`, `./src/migrations.ts`) — one row per
  launched task: `id, tenantId, principalId, definitionId, prompt,
modelPreference, status, runId, resultMailId, createdAt, completedAt`. Own
  Postgres schema (`tasks`), own migration ledger — see
  `docs/package-migrations.md`.
- **`TaskStore`** (`./src/store.ts`) — `createDrizzleTaskStore` (production)
  and `createMemoryTaskStore` (tests/local smoke), same interface.
- **`launchTask`** (`./src/launcher.ts`) — the launch primitive. Looks up the
  target definition, reads its folded body (mirrors `@corbits/chat`'s
  `launchInvite` exactly, minus every channel/participant/settings concern),
  calls `launchFoldedRun` with `persistExtra` writing the task row in the
  same transaction as the run's principal/session/run rows, then sends the
  prompt as the opening mail via `sendFoldedMail`. **No channel is ever
  created** — a task-launched run has no `channel_settings` row, so it can
  never appear in a chat sidebar or channel listing (see
  `packages/tasks/test/task-not-in-channel-list.drizzle.test.ts`, the
  negative test that proves this).
- **`createTaskOrchestrator`** (`./src/orchestrator.ts`) — built once by the
  host, subscribed for the process's lifetime, mirroring
  `@corbits/chat`'s `createChatOrchestrator`. Subscribes to the sidecar's
  shared `"agent.event"` stream, keys events to a task by resolving the
  agent's address to its folded run and looking that run up in the task
  store (so it never fights over events with the chat orchestrator, which is
  also subscribed to the same stream and simply finds no task for its own
  addresses). On the run's terminal `message.run.ended` bracket close it
  delivers one Inbox item — reply text (cached from the last
  `connector.reply`) plus artifact chips (from `handleFinalizedTurn`, wired
  the same way chat wires `createArtifactDeliveryHandler`) — and flips the
  task to `done` or `failed`.
- **`createTaskRoutes`** (`./src/routes.ts`) — `POST /`, `GET /`, `GET /:id`,
  tenant-scoped, `requireGrant`-gated exactly like every other package's
  routes. The create route depends on an injected `launch` port rather than
  calling `launchTask` directly, mirroring how chat's routes depend on
  `platform.launchInvite` rather than folded-runs primitives — this keeps
  the route layer testable with a plain stub, no database.

## What the host must inject

- `db: DB["db"]` — the platform's own drizzle handle (workflowDefinition,
  tenant, workflowRun reads/writes go through this).
- `store: TaskStore` — `createDrizzleTaskStore(db)` in production.
- `foldedRuns: FoldedRunsDeps` — the same deps object chat's platform
  adapter builds (`db`, `sessionService`, `assetService`, `sidecarRouter`,
  `eventCollectors`).
- `cryptoProviders: CryptoProviderCache` — `createCryptoProviderCache()`
  from `@corbits/folded-runs`, one per task id (a task never re-sends after
  its opening mail, so this cache never grows unboundedly per task the way
  chat's per-channel cache does across a channel's lifetime).
- `isTaskableDefinition` — the host's verdict on which deployed definitions
  belong in the task picker. In `apps/hub` this is the same composed rule
  chat's `isInvitableDefinition` already uses: not a channel-host anchor
  (`!isChannelHostDefinitionName`) and not an automatable workflow-catalog
  entry (`!isAutomatableWorkflowName`).
- `lifecycle` (optional) — the same `AgentLifecycle` instance chat's
  platform adapter drives, so a task-launched run's idle-sleep clock is
  shared with every other folded run in the process.
- `notify: NotifyDeliveryDeps` (for the orchestrator) — the same
  `mailboxDelivery`/`addressing`/`dispatch`/`sinks` bundle
  `credentialExpirySweep` already uses in `apps/hub/src/index.ts`.
- `requireGrant` (for the routes) — the same `createRequireGrant(...)`
  factory every other tenant-scoped route package takes.

## What this package never imports

- Nothing under `vendor/intx/**` directly — every platform capability
  (credential resolution, launch, session orchestration, ID generation)
  arrives through `@corbits/folded-runs` and `@intx/*` published surfaces,
  the same seam `@corbits/chat` uses.
- No channel/participant/settings machinery. A task is not a chat channel
  with one participant; it is a bare folded run.

## Known gap: launch-time model override

A task's `modelPreference` is recorded on the row and offered in the UI
(when the tenant's dynamic model catalog — `GET
/tenants/:id/catalog/models` — offers more than the empty set), but **it
does not currently change which model the run actually uses.**
`launchFoldedRun` → `deployAtHead` resolves a run's inference source via
`resolveDefinitionSources` (`vendor/intx/hub-api`), which is explicit that
"a run's inference source comes from its definition resolved against the
tenant catalog — never from the request body." The only override path
(`SourcesOverride`) bypasses catalog-based credential resolution entirely —
exactly what chat's noop channel-host path uses, and exactly the kind of
credential-resolution reimplementation `AGENTS.md` forbids for anything
that ought to be a real run. Until Interchange exposes a per-launch model
preference (the currently-always-`{}` `invokerPreferences` knob on
`resolveDefinitionSources` looks like the intended seam), a task always
launches against its definition's own baked-in catalog default, exactly
like `launchInvite` does today.

## Lifecycle visibility: delivered on completion only

A task row is written the moment it launches (`status: "running"`), but
nothing surfaces in the **Inbox** until the run finishes — there is no
"task running…" placeholder inbox item. Mid-task tool approvals still
reach the Inbox immediately, through the existing needs-you flow, which
this package does not rebuild or touch: `createTaskOrchestrator` only ever
observes `connector.reply` and `message.run.ended`, never
`reactor.gate.blocked`, so an approval park for a task-launched run is
handled the same way it always was, by the platform's own approval
machinery. A task's own list/detail routes (`GET /tasks`, `GET
/tasks/:id`) are the way to check on a still-running task before it
completes.
