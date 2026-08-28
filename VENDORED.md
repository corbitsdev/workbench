# Vendored code

This file is the ledger of every vendored path in the repository. Workbench
consumes third-party code as published packages; vendoring is a sanctioned
escape hatch for the rare case where a needed capability is not published —
never a convenience.

## Rules

- Vendoring is hand-copied files only — never a git submodule.
- Every vendored path has exactly one row in the ledger below. Code copied into
  the tree without a ledger row is not vendored; it is a bug.
- Every entry carries a **kill date** — the date by which the vendored copy is
  replaced by a published package or deliberately renewed — and a dated test
  that fails after that date. An entry with no kill date is not an entry.
- The ledger row, the kill date, and its dated test land in the same commit as
  the copied files.
- Local changes to vendored code land in this repository through normal review.
  The upstream repository is never modified, committed to, or pushed to.
- Retiring a vendored copy closes the entry: delete the row, the files, and the
  kill-date test together.

## Ledger

| Vendored path                 | What was copied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Upstream repo @ commit                                                                                   | Why not a published package                                                                                                                                                                                                                                                                                                                                                                                                  | Owner  | Kill date  | Kill-date test    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------- |
| `apps/sidecar`                | Derived from upstream's own `apps/sidecar`: of 38 tracked `src/` modules, 5 are byte-identical to upstream (`default-harness.ts`, `source-asset-delivery.ts`, `workflow-closure-apply.ts`, `workflow-probe-handler.ts`, `workflow-run-pack-restore.ts`), 10 are substantially rewritten under the same name (`atomic-write.ts`, `config.ts`, `conversation-state.ts`, `index.ts`, `run-grants.ts`, `signing-keypair.ts`, `step-agent-tools.ts`, `tool-materialization.ts`, `workflow-closure-materialization.ts`, `workflow-run-pack-client.ts`), and the remaining 23 are workbench-only, including the `workflow-host-wiring/` and `workflow-substrate-factory/` module splits of upstream's single-file `workflow-host-wiring.ts` and `workflow-substrate-factory.ts`. A living fork, not a frozen copy, so this row carries no tree hash. | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | An app is never npm-published, so no publish can cover the execution host; retired by consuming an upstream-published host, or by renewing this row deliberately                                                                                                                                                                                                                                                             | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/agent`           | `@intx/agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the operator-configurable doom-loop threshold (`afd0c82b`, `c421c092`) the re-vendored `workflow-host` configures; no local delta; retired by the next `@intx/agent` publish                                                                                                                                                                                                                              | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/db`              | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | npm 0.3.0 covers the base package but not the `wire_projection` column/loader delta (CL-6324) or the `workflow_definition.origin` column separating a definition from the per-run record of one folded run's deploy (CL-6452); retired when upstream absorbs the deltas                                                                                                                                                      | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/hub-api`         | `@intx/hub-api` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | npm 0.3.0 covers the base package but not the exported null-principal `resolveApproval` (CL-6345) or the bearer-authenticated workflow-deploy mirror (`middleware/workflow-run-deploy-auth.ts`, CL-workflow-deploy-bearer); retired when upstream absorbs the deltas                                                                                                                                                         | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/hub-sessions`    | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | npm 0.3.0 covers the base package but not the usage forward (CL-5879), pack-acceptance fixes, adopted deploy front, wire-projection writer, event-collector serialization, anchor ordering, or malformed tool-call-name sanitization (CL-6478)                                                                                                                                                                               | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/inference`       | `@intx/inference` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates doom-loop detection (`8da4c827`, `afd0c82b`, `c421c092`); one local delta: `providers/google-genai-files.ts` builds its upload body as `new Uint8Array(bytes)` because TS 6's lib.dom `BodyInit` rejects `Uint8Array<ArrayBufferLike>` (upstream compiles ESNext-only under TS 5.9); retired by the next publish                                                                                          | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mail-memory`     | `@intx/mail-memory` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the `@intx/mailbox` extraction (`af03bb90`), on-demand body reads (`54f7c239`) and `expunge` returning the swept uids (`bcabb1f8`) that the re-vendored `workflow-host` binds against; no local delta; retired by the next publish                                                                                                                                                                        | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mailbox`         | `@intx/mailbox` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | Never published: a new package at the target pin (`af03bb90`) that `workflow-host`'s substrate mailbox store and supervisor-backed transport import; no local delta; retired by its first publish                                                                                                                                                                                                                            | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/mime`            | `@intx/mime` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the non-RFC message-id guard `isMessageId` (`d97e1832`), the full `References` chain (`65c6fe70`) and the lossless `decodeMail` decoder (`3b6d06b2`) that `mailbox`/`mail-memory` at the same pin import; no local delta; retired by the next publish                                                                                                                                                     | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/types`           | `@intx/types` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `a8bc06ae` (origin/main, 2026-08-27) | npm 0.3.0 predates the type surface the re-vendored trees compile against: `expunge` returning `expungedUids` (`bcabb1f8`), plain-string `PackRejectReason` (`7b42f405`), the run authorization/approvals REST types (`71ad6c08`), the decoded-mail `Mail`/`MailPartReader` model (`3b6d06b2`) and the `interchange.actions`/`loops` package-json refs (`3bd5b837`, `1ea2f39b`); no local delta; retired by the next publish | sawyer | 2026-10-26 | `check:killdates` |
| `vendor/intx/workflow`        | `@intx/workflow` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | npm 0.3.0 covers the base package but not the `onBodyFailure` trigger policy and its projection (CL-6326, CL-6324); retired when upstream absorbs the delta                                                                                                                                                                                                                                                                  | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/workflow-deploy` | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | Carries no delta of its own, but must bind against the vendored `@intx/workflow` (whose `onBodyFailure` field flows through the projection it hashes); retired with the workflow delta                                                                                                                                                                                                                                       | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/workflow-host`   | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0)                  | npm 0.3.0 covers the base package but not the empty-mail drop (CL-6164), the action/loop runtime bind (CL-6325; its adapters live in `packages/workflow-host-actions` since CL-6435), or the body-spawn authorize/credential threading (CL-6448); retired when upstream absorbs the deltas                                                                                                                                   | sawyer | 2026-09-19 | `check:killdates` |

The re-pin to `a8bc06ae` (upstream `origin/main`, 2026-08-27, 72 commits past
`v0.3.0`) is landing row by row; npm is still `0.3.0`, so every tree an
already re-pinned tree imports at a newer API is vendored too, all at the
same commit — a vendored tree never mixes pins. The root `package.json`
`overrides` therefore point each vendored name at `workspace:*` (so the
published `@intx/harness`, `@intx/hub-agent`, `@intx/tool-packaging`,
`@intx/authz`, … resolve their own `@intx/*` dependencies onto the vendored
copies instead of a second npm copy) and keep the unchanged names on `0.3.0`.
`vendor/intx/workflow-host` (still at `b5580a02` until its own re-pin)
carries one bridging edit against the re-pinned `@intx/types`: its
supervisor-backed transport's `expunge` stub returns
`Promise<{ expungedUids: number[] }>` (upstream `bcabb1f8`); it disappears
with that tree's re-pin.

The pinned commit `b5580a02` is upstream's `v0.3.0` release tag, 16 commits
past the previous pin `4ed8baf4`: a workflow-host supervisor
crash-respawn/backoff policy with a `RunFailed` terminal commit when the
crash-loop guard latches, credential/wallet deletion guards with
per-credential grant cleanup (and the removal of the dead `bindingGrants`
construction from `buildCredentialDelivery`), and an orphaned-grant cleanup
migration (upstream `0084`, which took the number our `wire_projection`
migration held — ours is renumbered `0085`).

v0.3.0 is also the first release whose `@intx/*` npm publishes cover the
folded model, so the fifteen previously vendored trees that carried no local
delta — `agent`, `authz`, `crypto`, `harness`, `hub-agent`, `hub-common`,
`inference`, `inference-catalog`, `log`, `mail-memory`, `mime`,
`pack-transport`, `storage-isogit`, `tool-packaging`, `types` — are retired:
deleted and consumed as published `@intx/*@0.3.0` packages. The six rows
above survive only because each carries (or must bind against) a local delta
the publish lacks. The root `package.json` `overrides` pin every `@intx/*`
name to `0.3.0` so external dependencies' older exact pins collapse onto the
same resolution workbench uses: the npm publish for retired names, the
vendored workspace copy for surviving ones.

Local modifications (all surviving `vendor/intx/*` rows): each package's
exports map is repointed from the upstream `intx-src` resolve condition to
direct TypeScript source resolution (`types`/`default` → `./src/...`), with
`dist/` references and the `customConditions` entry in the shared tsconfig
removed — workbench forbids custom resolve conditions — and each tsconfig
carries `types: ["bun"]`; `vendor/intx/hub-api`
adds a `@types/ssri` devDependency that bun's isolated linker does not hoist
from tool-packaging the way upstream's install does.
`vendor/intx/hub-api` (CL-workflow-deploy-bearer) also adds
`middleware/workflow-run-deploy-auth.ts`, an optional bearer-authenticated
mirror onto the SAME session-cookie `POST/GET .../workflows/deployments`
route `routes/workflows.ts` already mounts (that route file is otherwise
untouched — no deploy logic is duplicated). It is the missing bearer path
every other workflow-run write surface (skills, capabilities, routines,
agent-directory) already has: a workflow-run agent has no browser session,
only its sidecar bearer token and its own run address. `MountHubRoutesDeps`
and `CreateAppOpts` gain an optional `workflowRunAuthenticator`; when
supplied, the new middleware mounts ahead of `createResolveTenant` (which
already short-circuits once `principal`/`tenant` are set — the same seam the
git-token/asset bearer routes use), so a bearer-authenticated request reaches
the exact same handler as a human session: same `requireGrant("workflow:*",
"create")` gate (already in `SEED_GRANTS`, so no grant changes were needed),
same asset tenant-scoping (a foreign-tenant asset already read as `not_found`
before this change and still does), same install/probe/gate/freeze call into
`sessionService.deployWorkflowFromSource`. A request with no bearer
credential falls through unchanged to the session path.
`vendor/intx/hub-sessions` (CL-5879) forwards `inference.usage` events —
previously matched by `event-collector.ts`'s "not persisted" default and
dropped — to a new optional `onUsage` callback on `createEventCollector`
and `createEventCollectorRegistry`, carrying `{turnId, provider, model, usage}` plus
the registry's own `tenantId`/`sessionId`; no new persistence lands in the
vendored copy itself, only the forward, and `apps/hub/src/index.ts` wires
it to `@corbits/insights`' `createUsageSink` so `usage_turn` rows are
written for the first time. `vendor/intx/hub-sessions` also drops the
live-status gate on `receiveWorkflowRunPack`'s anchor lookup: the gate is now
the exported pure helper `ownsWorkflowRunRepo` (a self-anchored `workflow_run`
row with a routable address), with the allocation fences unchanged. Upstream
required `status in (deployed, running)`, which wedged every terminal run that
still had mail in flight into a permanent loop — the run's own inbox-enqueue
and `markConsumed` rejection packs were refused as `path_violation`, the
sidecar withheld the ack, and the hub redelivered forever
(`docs/revendor-inventory.md`). `vendor/intx/hub-sessions` (CL-6361) also
widens that same anchor lookup to resolve a per-step pack source address
(`deriveStepAddress`'s `<runId>-<stepId>@<domain>`,
`vendor/intx/workflow-deploy/src/orchestrator.ts:837`) back to its base run's
anchor address via the new pure helper `anchorAddressForPackSource`. Upstream
keys the lookup on an exact `workflow_run.address` match, which only the
anchor row ever carries; a multi-step deployment's per-step agents push their
own event-log commits (e.g. a step named `write`) under their step-suffixed
address, so every such pack was rejected `path_violation` with "source
address has no deployment anchor it owns," the sidecar withheld the ack, and
the hub redelivered forever — the same infinite-retry shape as the terminal-run
case above, one layer up the address hierarchy. `vendor/intx/workflow-host`
(CL-6164) drops
inbound mail carrying no conversation text on the parked-resume path rather
than delivering an empty string that throws inside `agent.send` and fails the
step with `retriesExhausted`; the gate is the new pure helper
`hasConversationText`. `vendor/intx/workflow-host` (CL-6325, slimmed by
CL-6435) additionally carries the run-child bind for the action/loop
runtime seam upstream defines but never populates. The action-primitive
adapters themselves (action invoker, effect ledger, run-blobs helpers,
plus their tests) no longer live in the vendor tree: CL-6435 extracted
them to the first-class package `packages/workflow-host-actions`
(`@corbits/workflow-host-actions`), which `run-child.ts` imports — the
vendored delta is now only the bindings fields, the once-per-child
registry resolution, and `buildRuntimeEnv`'s call into the package (the
vendored `package.json` gains the matching `workspace:*` dependency).
The bind itself: `RunWorkflowChildBindings` gains
`resolveActionHandler` — awaited once per child, after the definition
re-verify, with the resolved `WorkflowDefinition` and the live
`CredentialWiring`, so the app-owned registry
(`apps/sidecar/src/action-tool-handler.ts`) eagerly materializes every
action step's tool closure at establish and scopes credentials through
the same per-step grant wiring agent steps use — and `loopFns`, both
defaulting to the fail-closed empty registries; `buildRuntimeEnv` wires
`effects`, `invokeAction`, `loopFns`, and `runLoopIteration` into every
run's env and is exported so a host's runtime-env-level probe
(`apps/sidecar/test/action-runtime-env.test.ts`) can exercise the bind
without the full control-channel harness. `vendor/intx/workflow-host`
(CL-6448) also threads the parent child's credentials-backed authorize and
live `CredentialWiring` through the suspendable-child (onTrigger body) spawn
seam: `RunSuspendableChild`'s input and
`createInMemorySpawnSuspendableChild`'s opts gain optional
`authorize`/`credentialWiring` fields, and `run-child.ts` passes both when
building the body resolver, so a body agent's tool calls gate through the
same per-step grant snapshot a top-level step's do instead of the host's
throwing authorize stub. Upstream never runs tool-bearing body agents, so
the seam has no upstream analog yet. `vendor/intx/workflow` (CL-6326, CL-6324) gives
`onTrigger` an `onBodyFailure?: "end" | "continue"` policy: absent or `"end"`
preserves terminal-is-final, while `"continue"` lets a long-lived section
re-arm past a `failed` body occurrence instead of one bad turn permanently
ending the section. Cancellation is unaffected — it reflects a drain/operator
decision, not a turn-level error — and the failed occurrence stays on the
run's durable audit log either way, so the policy makes it non-fatal, never
silent. The live→inert projector carries the field too, so an authored policy
survives the child→hub projection the deploy gate hashes rather than being
dropped on the way. `vendor/intx/hub-sessions` (CL-6324) adds a third
code-sourced deploy front, `deployAdoptedCodeSourcedWorkflow`, which deploys
onto shared capacity while adopting an anchor `workflow_run` row the caller
already owns. Neither upstream front can: `deployWorkflowFromSource` inserts
its anchor row, which collides with a folded run's existing one, and threads
no credential cipher; `deployPreparedCodeSourcedWorkflow` updates a
pre-existing row and threads the cipher but only under the
allocation-ownership lock, so it cannot run on shared capacity. The new front
composes the same private halves and follows the prepared front's semantics
minus that lock. `vendor/intx/db` and `vendor/intx/hub-sessions` (CL-6324) together
persist a definition's evaluated inert projection at approval time:
`workflow_definition_version` gains a `wire_projection` jsonb column
(migration `0085_workflow_definition_version_wire_projection.sql`, renumbered
from `0084` when upstream v0.3.0 took that slot; the journal keeps the
original `when` timestamp so databases that already applied it do not re-run
the `ADD COLUMN`),
`createDbFrozenApprovalWriter` stamps it in the SAME transaction that
writes `approved_wire_hash`, and `loadFrozenWireProjection` reads it back
validated as a `WorkflowProjectionDefinition`. Upstream carries no
hub-side record of a deployed definition's body at all — under the
`workflow.json` retirement the body is whatever the source closure
evaluates to on the sidecar, and a source-format asset holds no envelope
to read it back from — so every hub-side launch that needs the body (a
folded run's system prompt, tool pins, model, credential bindings) had
nowhere to get it. Keyed to the approved wire hash and stored beside it,
this is one store per concept, not a second copy: the projection and the
hash that addresses it are written and read together.
`vendor/intx/hub-sessions` (CL-6379) serializes the event
collector's `onEvent`/`abandon` through an internal promise chain: the
registry's dispatch is deliberately fire-and-forget, and without the chain
two events interleave across their DB awaits — a `connector.reply` finalize
nulls the current turn while `inference.done` is still inserting parts
(dropped as "no active turn"), and a finalize processed during the next
`inference.start`'s begin-insert marks the NEW turn finalized, leaving its
row "running" forever. The same change classifies an accepted workflow-run
pack's newly-terminal runs through the new pure `decideTerminalRunFlip`
before the DB flip: a section occurrence's repo-local child run
(`turn__<n>`) has no `workflow_run` row by design and is skipped quietly
instead of being logged as a foreign-deployment violation on every turn.
`vendor/intx/hub-sessions` (CL-6388) reorders
`deployCodeSourcedWorkflow`, the SHARED code-sourced deploy front, to
persist its anchor `workflow_run` row BEFORE emitting the source-ref
deploy frame. Upstream inserted the row only after the sidecar's deploy
ack, but the frame spawns the deployment's child, whose first
`refs/heads/events` pack push races that ack back to the hub —
`receiveWorkflowRunPack` fails closed (`path_violation`) on a missing
anchor row, so every fresh deployment's first events pack was rejected
and the durable event log never bootstrapped. The row is born with a
null `publicKey` (the reconnect challenge keeps failing closed until the
ack), the acked supervisor key is stamped afterwards, and a failed frame
emit deletes the pre-inserted row. The prepared and adopted fronts
already had their anchor row pre-frame; the shared front now matches
them. `vendor/intx/hub-sessions` (CL-6395) narrows that failed-emit
deletion: CL-6388 deleted the pre-inserted anchor on ANY
`emitSourceRefDeployFrame` rejection, but an ack-timeout or socket-drop
rejection fires strictly after the `agent.deploy` frame already reached
the sidecar, so deleting the row could permanently orphan an
already-spawned child on the missing-anchor `path_violation` path.
`ws/sidecar-handler.ts` now exports `DeployFrameNotSentError`, thrown only
where a guard clause or the `conn.send()` call itself fails before the
frame could have reached the wire; `deployCodeSourcedWorkflow` deletes the
row only on that error and otherwise keeps the row and logs a
reconciliation line. `vendor/intx/hub-sessions` (CL-6478) adds a
`sanitize-tool-name.ts` module and calls it from `event-collector.ts`'s
`tool_call` handling: `@intx/inference`'s `decodeToolName` is deliberately
total and returns a hallucinated or provider-mangled function name
verbatim, but `encodeToolName` throws when that same name is put back on
the wire for the next turn's outbound request — persisting a decoded name
unchecked meant the room's very next turn died rebuilding its request,
permanently, once the bad name was durable. Only a name `encodeToolName`
can re-invert is now persisted as-is; anything else collapses to a stable
`malformed_tool_call` placeholder before it reaches `turnPart`, so a single
bad tool-call name fails that turn cleanly instead of wedging the room.
`@intx/inference` is added to `vendor/intx/hub-sessions`'s own
`package.json` dependencies for this.
`vendor/intx/hub-sessions` (CL-6595) fixes `workflow-run-kind.ts`'s
newly-terminal detection, which skipped a run's `events.jsonl` subtree
entirely (`enumerateEventBlobs` only walks per-event `<seq>.json` files),
so a run sealed from birth — its whole event log arriving pre-combined in
one push, with no per-event blobs ever landing — never fired `markTerminal`
and stayed "running" in `workflow_run.status` forever despite the run
having genuinely finished; `validatePush` now also scans a newly-sealed
run's combined log for its terminal event, and `hub-session-lookups.ts`
gained a same-push defense-in-depth backfill via the new
`readCommittedWorkflowRunTerminalStatus` export, in case a future pack still
slips past the primary detection.
Each package's `VENDORED-FROM` file restates its own delta.

`apps/sidecar` records `b5580a02` (v0.3.0): the fork tracks the
closure-sourced lineage. Four modules are near-verbatim copies of upstream's
own — `workflow-probe-handler.ts`,
`workflow-closure-materialization.ts`, `workflow-closure-apply.ts`,
`source-asset-delivery.ts` — plus `bin/workflow-probe-child`; each is adapted
only where the fork's module layout differs (the host-platform resolution
lives in this fork's `tool-materialization.ts`, and the probe child's shebang
drops upstream's `intx-src` condition, which workbench forbids). The
remaining shared modules stay substantially rewritten, as the row records.

### Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove `vendor/intx/*` from the root
      `package.json` workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*`, `packages/*`, and
      `workflows/*` to the published npm version that covers each surviving
      tree's delta, and drop the root `overrides` pins.
- [ ] Delete the six ledger rows above and the local-modifications note.
- [ ] Drop the `vendor/intx/*` rows from `scripts/checks/kill-dates.txt`.
- [ ] `bun install`
- [ ] `bun run check`
