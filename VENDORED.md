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

| Vendored path                 | What was copied                                                                                                                                                                                                                                                                                                                                 | Upstream repo @ commit                                                                  | Why not a published package                                                                                                                                                                                                                                                                | Owner  | Kill date  | Kill-date test    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------- | ----------------- |
| `apps/sidecar`                | Derived from upstream's own `apps/sidecar`: 11 shared modules, of which `signing-keypair.ts` is near-verbatim and the rest (`index.ts`, `config.ts`, `tool-materialization.ts`, `workflow-run-pack-client.ts`, …) are substantially rewritten, plus workbench-only modules. A living fork, not a frozen copy, so this row carries no tree hash. | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | An app is never npm-published, so no publish can cover the execution host; retired by consuming an upstream-published host, or by renewing this row deliberately                                                                                                                           | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/db`              | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs)                                                                                                                                                                                                                                                                  | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | npm 0.3.0 covers the base package but not the `wire_projection` column/loader delta (CL-6324); retired when upstream absorbs the delta                                                                                                                                                     | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/hub-api`         | `@intx/hub-api` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | npm 0.3.0 covers the base package but not the `needs-you` approval-route reservation or the exported null-principal `resolveApproval` (CL-6345); retired when upstream absorbs the deltas                                                                                                  | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/hub-sessions`    | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | npm 0.3.0 covers the base package but not the usage forward (CL-5879), pack-acceptance fixes, adopted deploy front, wire-projection writer, event-collector serialization, or anchor ordering                                                                                              | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/workflow`        | `@intx/workflow` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | npm 0.3.0 covers the base package but not the `onBodyFailure` trigger policy and its projection (CL-6326, CL-6324); retired when upstream absorbs the delta                                                                                                                                | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/workflow-deploy` | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | Carries no delta of its own, but must bind against the vendored `@intx/workflow` (whose `onBodyFailure` field flows through the projection it hashes); retired with the workflow delta                                                                                                     | sawyer | 2026-09-19 | `check:killdates` |
| `vendor/intx/workflow-host`   | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                       | [faremeter/interchange](https://github.com/faremeter/interchange) @ `b5580a02` (v0.3.0) | npm 0.3.0 covers the base package but not the empty-mail drop (CL-6164), the action/loop runtime bind (CL-6325; its adapters live in `packages/workflow-host-actions` since CL-6435), or the body-spawn authorize/credential threading (CL-6448); retired when upstream absorbs the deltas | sawyer | 2026-09-19 | `check:killdates` |

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
from tool-packaging the way upstream's install does, and its approval param
routes exclude the reserved segment `needs-you` so hosts can mount a sibling
`/approvals/needs-you` list without `/:approvalId` capturing it;
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
reconciliation line.
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
