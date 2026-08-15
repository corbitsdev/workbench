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
modelPreference, status, runId, resultMailId, plannerRunId, createdAt,
completedAt`. `plannerRunId` is nullable and set post-hoc by a planner —
  see CL-6051. Own
  Postgres schema (`tasks`), own migration ledger — see
  `docs/package-migrations.md`. The task id is hand-prefixed (`task_` +
  16 hex bytes) because `@intx/hub-common`'s `generateId` has no "task"
  kind — [Intx gap] CL-6056 tracks adding one. **Phase-3 note:** `runId`
  is a unique column today — one task, one run. Task _chains_ (phase 3)
  break that cardinality; they need a `task_run` join table (task →
  ordered runs) and a migration off the unique index before any chain
  work starts.
- **`TaskStore`** (`./src/store.ts`) — `createDrizzleTaskStore` (production)
  and `createMemoryTaskStore` (tests/local smoke), same interface.
- **`launchTask`** (`./src/launcher.ts`) — the launch primitive. Looks up the
  target definition, reads its folded body (mirrors `@corbits/chat`'s
  `launchInvite` exactly, minus every channel/participant/settings concern),
  calls `launchFoldedRun` with `persistExtra` writing the task row in the
  same transaction as the run's principal/session/run rows, then sends the
  prompt as the opening mail via `sendFoldedMailWithRetry`. An opening
  prompt that still fails after every retry never throws over the
  already-committed run: the task settles as `failed` with an honest
  Inbox item, and the caller gets the failed record back. **No channel is
  ever created** — a task-launched run has no `channel_settings` row, so it
  can never appear in a chat sidebar or channel listing (see
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
  flips the task to `done` or `failed` FIRST — a synchronous in-process
  claim plus the store's conditional `WHERE status = 'running'` flip make
  redelivered terminal events (sidecar reconnect replays) collapse to
  exactly one delivery — then writes one Inbox item: reply text (cached
  from the last `connector.reply`) plus artifact chips (from
  `handleFinalizedTurn`, wired the same way chat wires
  `createArtifactDeliveryHandler`). The notification's dedupe key is
  `task-result:{taskId}`, stable across delivery attempts.
- **`createTaskRoutes`** (`./src/routes.ts`) — `POST /`, `GET /`, `GET /:id`,
  tenant-scoped, `requireGrant`-gated exactly like every other package's
  routes — and deliberately tighter than the grant alone: **tasks are
  personal.** A prompt is private to whoever wrote it, so list and detail
  filter to the requesting principal's own tasks; a same-workbench
  colleague's task reads as absent (404), never forbidden. The create route
  depends on an injected `launch` port rather than calling `launchTask`
  directly, mirroring how chat's routes depend on `platform.launchInvite`
  rather than folded-runs primitives — this keeps the route layer testable
  with a plain stub, no database. Error copy at this boundary is plain
  language for the person who clicked "Start task"; the technical detail
  goes to the server log.

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
  belong in the task picker. In `apps/hub` this is literally the same
  predicate chat's `isInvitableDefinition` is wired to
  (`isConversationalAgentDefinition`: not an automatable workflow-catalog
  entry; the platform side already excludes channel-host anchors).
- `lifecycle` (optional) — the same `AgentLifecycle` instance chat's
  platform adapter drives, so a task-launched run's idle-sleep clock is
  shared with every other folded run in the process.
- `notify: NotifyDeliveryDeps` (for the launcher AND the orchestrator) —
  the same `mailboxDelivery`/`addressing`/`dispatch`/`sinks` bundle
  `credentialExpirySweep` already uses in `apps/hub/src/index.ts`. The
  launcher needs it for the prompt-delivery-failed settle; the
  orchestrator for every terminal result.
- `requireGrant` (for the routes) — the same `createRequireGrant(...)`
  factory every other tenant-scoped route package takes.

## What this package never imports

- Nothing under `vendor/intx/**` directly — every platform capability
  (credential resolution, launch, session orchestration, ID generation)
  arrives through `@corbits/folded-runs` and `@intx/*` published surfaces,
  the same seam `@corbits/chat` uses.
- **Not `@corbits/chat`.** The one thing tasks and chat genuinely share —
  recognizing persisted Library artifacts in a finalized turn — lives in
  `@corbits/turn-artifacts`, which both depend on; the shared
  `agent.event` recognizers (`connectorReplyContent`, `messageRunEnded`)
  live in `@corbits/folded-runs`, which both already build on.
- No channel/participant/settings machinery. A task is not a chat channel
  with one participant; it is a bare folded run.

## Model preference

A task's `modelPreference` is a real per-launch pin, not a stored wish:
the launcher rebuilds the launch body with the picked catalog model in
its `model` field, and `launchFoldedRun` → `deployAtHead` resolves that
model against the tenant catalog (`resolveDefinitionSources`'
`fallbackModel`) with the same credential-ownership checks a
definition's own declared model gets — never a `SourcesOverride`, which
would bypass the catalog. No preference means the definition's baked-in
model, exactly like `launchInvite`.

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

## UI: global shortcut and the agent-selection seam

`@corbits/tasks-ui`'s `TaskComposerDialog` is reachable in one keystroke —
`apps/web` registers a global Cmd+T/Ctrl+T listener at the same shell level
(`CommandPaletteProvider`, mounted once in `app.tsx`'s `Shell`) react-ui's
own Cmd+K listener uses, guarded the same way (repeat-key and
editable-target skipped, `metaKey || ctrlKey` accepted so mac and non-mac
both work without OS-sniffing). **Caveat:** browsers and OSes reserve
Cmd+T/Ctrl+T for "new tab" and intercept the keystroke before many pages
ever see it, in many browser/OS combinations — this listener only fires in
the cases the browser doesn't claim first. The command palette's own "New
task" entry (`> New task`) is the reliable fallback, unaffected by that
reservation, and funnels through the identical `runActionCommand("new-task",
…)` path.

The dialog's "Agent" field is an injected `AgentSelectionStrategy`
(`packages/tasks-ui/src/agent-selection-strategy.tsx`), not a hardcoded
picker. `createManualAgentSelectionStrategy` — the fetched-definition-list,
click-to-select surface the composer always had — is the only strategy
wired today, explicitly, by `apps/web/src/pages/inbox-page.tsx`. The seam
exists so a later programmatic strategy (CL-6050, "Myra auto-dispatch") can
be swapped in without reworking the dialog's layout, submit, or model-select
logic — nothing in this repo builds or shows an auto-pick affordance yet.
`initialDefinitionId` preselects the field from a per-bench
most-recently-used-agent value in `localStorage`
(`apps/web/src/task-mru-agent.ts`) — browser-local only, never round-tripped
through `@corbits/preferences`, since losing it on a new device costs
nothing more than one manual pick.
