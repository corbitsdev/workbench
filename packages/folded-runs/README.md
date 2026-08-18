# @corbits/folded-runs

Launch, wake, and mail machinery for folded interactive workflow runs,
hosted-service-agnostic: the shared substrate `@corbits/chat` and
`@corbits/tasks` both build on rather than each reimplementing their own
copy of "start a run, send it mail, read its mailbox." Every side effect
that touches a real host — the database, the session service, the sidecar
router, the event-collector registry — arrives as an injected
`FoldedRunsDeps` port (`./src/types.ts`); this package never imports a hub
or a host-specific package such as `@corbits/chat`.

## What this package owns

- **`FoldedRunsDeps`** (`./src/types.ts`) — the one dependency bundle every
  surface in this package takes: `db`, `sessionService`, `assetService`,
  `sidecarRouter`, `eventCollectors`.
- **Definition reading** (`./src/definition.ts`) — `readDefinitionJSON` +
  `readFoldedBody` pull a folded `WorkflowDefinition`'s launch body back out
  of its materialized workflow asset, reimplemented here rather than
  imported from `@intx/hub-api`'s hub-api-internal helper.
- **Crypto provider caching** (`./src/crypto-cache.ts`) —
  `createCryptoProviderCache` mints one `CryptoProvider` per cache key
  (a workbench id, an instance id, ...) and reuses it for the cache's
  lifetime; never evicted, since a key going momentarily unreachable does
  not mean it is gone for good.
- **Run lookups** (`./src/runs.ts`) — resolving a run by id or address, and
  bridging a run's principal to its live session via the shared-principal
  bridge.
- **Launch** (`./src/launch.ts`) — `launchFoldedRun`/`deployAtHead` start a
  folded interactive run: the same address family (`principalId` set,
  `deploymentId: null`) `POST /workflows/runs` produces, not the native
  workflow-deploy-anchor path.
- **Wake** (`./src/wake.ts`) — `wakeFoldedRun` re-deploys a folded run's
  instance when the sidecar no longer has it resident, from a caller-supplied
  `foldedBody` (this package has no launch-body table of its own to read).
- **Mail** (`./src/mail.ts`) — `sendFoldedMail`/`sendFoldedMailWithRetry`/
  `listFoldedMail`: signing and persisting a message into a run's mailbox,
  and walking that mailbox with keyset pagination.
- **Agent event recognizers** (`./src/agent-events.ts`) —
  `connectorReplyContent`/`messageRunEnded` parse the sidecar `agent.event`
  frames every folded-run observer keys off. Both process-wide
  orchestrators (`@corbits/chat`'s and `@corbits/tasks`') subscribe to the
  same stream and need the same two readings, so the parsing lives here
  once instead of duplicated in each.
- **The one-shot reply runner** (`./src/one-shot-reply.ts`) —
  `runOneShotFoldedPrompt` is a synchronous "launch one folded run, send one
  prompt, await exactly one reply" primitive: it launches a run, sends
  `prompt` as its opening mail, and resolves with the accumulated
  `connector.reply` content once the run's `message.run.ended` bracket
  closes, or rejects with `FoldedRunFailedError` (the run itself ended
  `"failed"`) or `FoldedRunTimedOutError` (its timeout elapsed first). It
  exists for a caller with no Inbox and no task row to hang an async
  delivery on — `@corbits/tasks`' own `launchTask` returns as soon as the
  run launches and lets its reply land later, through
  `createTaskOrchestrator`'s subscription to the same event stream; this is
  the one place that turns that same stream into an awaitable promise
  instead. Every settle path (success, run failure, timeout, or a
  send-path throw) tears the launched run down through the required
  `undeploy` port before the outer promise resolves or rejects — a
  one-shot run has no further purpose once it settles, unlike a
  `@corbits/tasks`-launched run, which lives on tracked by idle-sleep. It
  was promoted into this package from `@corbits/task-planner` (CL-6051
  finding 12): CL-5917's routine chains need this exact primitive without
  depending on `@corbits/task-planner`'s `TaskSpec`, which is why it lives
  at this layer and not there. `@corbits/task-planner`'s `runPlanner` is
  the first caller, and re-exports the same names from its own barrel for
  its callers' convenience.

## What the host must inject

- `FoldedRunsDeps` — `db`, `sessionService`, `assetService`,
  `sidecarRouter`, `eventCollectors`, the same bundle every surface in this
  package shares.
- For `runOneShotFoldedPrompt` specifically: `events: SidecarEventEmitter`,
  `cryptoProviders: CryptoProviderCache`, a required `undeploy: (address,
reason) => Promise<void>` (the host's own termination primitive — e.g.
  `apps/hub`'s `sidecarRouter.sendAgentUndeploy`), and an optional
  `lifecycle?: Pick<AgentLifecycle, "track" | "recordActivity" |
"untrack">` for idle-sleep bookkeeping shared with the rest of the
  process's launched runs.

## What this package never imports

- Nothing host-specific: no `@corbits/chat`, no `@corbits/tasks`, no
  `apps/*`. Every side effect that touches a real host arrives as an
  injected port.

## Running tests

```sh
cd packages/folded-runs && bun test
```

Tests run against injected fakes for `FoldedRunsDeps`; no `DATABASE_URL`
is required.
