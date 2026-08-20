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

| Vendored path                   | What was copied                                                                                                                                                                                                                                                                                                                                 | Upstream repo @ commit                                                         | Why not a published package                                                                                                                                                        | Owner  | Kill date  | Kill-date test    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | ----------------- |
| `apps/sidecar`                  | Derived from upstream's own `apps/sidecar`: 11 shared modules, of which `signing-keypair.ts` is near-verbatim and the rest (`index.ts`, `config.ts`, `tool-materialization.ts`, `workflow-run-pack-client.ts`, …) are substantially rewritten, plus workbench-only modules. A living fork, not a frozen copy, so this row carries no tree hash. | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | An app is never npm-published, so no publish can cover the execution host; retired by consuming an upstream-published host, or by renewing this row deliberately                   | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/agent`             | `@intx/agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/authz`             | `@intx/authz` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/crypto`            | `@intx/crypto` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                              | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/db`                | `@intx/db` source (`src/`, `migrations/`, drizzle config, manifest, tsconfigs)                                                                                                                                                                                                                                                                  | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/harness`           | `@intx/harness` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-agent`         | `@intx/hub-agent` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-api`           | `@intx/hub-api` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                             | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-common`        | `@intx/hub-common` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                          | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/hub-sessions`      | `@intx/hub-sessions` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                        | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it, or by an upstream `inference.usage`-carrying event stream (CL-5879, whichever lands first) | sawyer | 2026-09-05 | `check:killdates` |
| `vendor/intx/inference`         | `@intx/inference` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                           | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/inference-catalog` | `@intx/inference-catalog` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                   | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/log`               | `@intx/log` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                 | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mail-memory`       | `@intx/mail-memory` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                         | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/mime`              | `@intx/mime` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                                | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/pack-transport`    | `@intx/pack-transport` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/storage-isogit`    | `@intx/storage-isogit` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/tool-packaging`    | `@intx/tool-packaging` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                      | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/types`             | `@intx/types` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                               | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow`          | `@intx/workflow` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                            | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-deploy`   | `@intx/workflow-deploy` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                     | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |
| `vendor/intx/workflow-host`     | `@intx/workflow-host` source (`src/`, manifest, tsconfig)                                                                                                                                                                                                                                                                                       | [faremeter/interchange](https://github.com/faremeter/interchange) @ `4ed8baf4` | npm 0.2.2 predates the folded model; retired by the next @intx npm publish covering it                                                                                             | sawyer | 2026-09-14 | `check:killdates` |

The pinned commit `4ed8baf4` is the tip of upstream `main` as of 2026-08-19,
a plain main-tip bump from `59f5e7b9`. The 45 commits it adds retire
`workflow.json`: a deployed workflow's definition is no longer serialized
into the deploy tree and re-read on the sidecar, it is evaluated from the
deployment's own source closure and re-verified in-child against the
approved wire hash. Source-ref is now the only deploy lineage — the
live-authored and instance deploy chains (`createWorkflowDeployOrchestrator`,
`SessionService.deploySingleStepAtHead`, `deployInstanceAtHead`,
`wrapHarnessAsSingleStepWorkflow`) are deleted upstream, `childWorkflow`
became an owned inline import resolved in memory, run grants derive from a
persisted grant-walk snapshot, and the child spawn adapters lost their
deploy-ref arguments (`createInMemorySpawnChild` /
`createInMemorySpawnSuspendableChild`). Eleven rows below carry trees that
are byte-identical at both commits; they move to the new pin so the ledger
records one commit rather than a mix. No published `@intx/*` version yet
covers any vendored path: npm still tops out at `0.2.2`, which predates the
folded model, so every row below stays vendored.

`apps/sidecar` now records `4ed8baf4`: its fork is converted onto the
closure-sourced lineage. Four modules are near-verbatim copies of upstream's
own at that commit — `workflow-probe-handler.ts`,
`workflow-closure-materialization.ts`, `workflow-closure-apply.ts`,
`source-asset-delivery.ts` — plus `bin/workflow-probe-child`; each is adapted
only where the fork's module layout differs (the host-platform resolution
lives in this fork's `tool-materialization.ts`, and the probe child's shebang
drops upstream's `intx-src` condition, which workbench forbids). The
remaining shared modules stay substantially rewritten, as the row records.

Local modifications (all `vendor/intx/*` rows): each package's exports map
is repointed from the upstream `intx-src` resolve condition to direct
TypeScript source resolution (`types`/`default` → `./src/...`), with `dist/`
references and the `customConditions` entry in the shared tsconfig removed —
workbench forbids custom resolve conditions; `vendor/intx/harness` drops the
unvendored `@intx/inference-testing` devDependency and `vendor/intx/hub-agent`
drops the unvendored `@intx/test-harness` devDependency; `vendor/intx/hub-api`
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
case above, one layer up the address hierarchy. `vendor/intx/inference`
narrows `UploadGoogleGenAIFileOpts.bytes` from `Uint8Array` to
`Uint8Array<ArrayBuffer>`: the bytes go straight out as a
`RequestInit.body`, and the DOM's `BodyInit` accepts only an
`ArrayBuffer`-backed view, so under a browser package's `lib` the
unnarrowed parameter is a hard type error while under a Node-only `lib` it
slips through undici's laxer `BodyInit`. The narrowing is what lets one
vendored file type-check identically in both. `vendor/intx/workflow-host`
(CL-6164) drops
inbound mail carrying no conversation text on the parked-resume path rather
than delivering an empty string that throws inside `agent.send` and fails the
step with `retriesExhausted`; the gate is the new pure helper
`hasConversationText`. `vendor/intx/workflow-host` (CL-6325) additionally
carries three adapter files (`adapters/action-invoker.ts`,
`adapters/effect-ledger.ts`, `adapters/run-blobs.ts`, plus their tests) that
are NOT from upstream faremeter/interchange at all — upstream's own
`packages/workflow-host` has no action-primitive adapters at the pinned
commit. They are copied from gtm-workbench's own `packages/workflow-host`
workspace fork (see `docs/revendor-inventory.md` for the full provenance
note and why no ordinary upstream-publish kill date applies to this
sub-delta). The same CL-6325 delta completes the run-child bind those
adapters exist for: `RunWorkflowChildBindings` gains
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
without the full control-channel harness. `vendor/intx/workflow` (CL-6326, CL-6324) gives
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
(migration `0084_workflow_definition_version_wire_projection.sql`),
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
them. `vendor/intx/inference-catalog`'s own local
modification also repoints the `./models` subpath's exports, not just the
root export.
Each package's `VENDORED-FROM` file restates its own delta.

### Un-vendoring `vendor/intx`

- [ ] Delete `vendor/intx/` and remove `vendor/intx/*` from the root
      `package.json` workspaces.
- [ ] Restore the `@intx/*` dependencies in `apps/*`, `packages/*`, and
      `workflows/*` to the published npm version that covers the vendored
      surface.
- [ ] Delete the twenty ledger rows above and the local-modifications note.
- [ ] Drop the `vendor/intx/*` rows from `scripts/checks/kill-dates.txt`.
- [ ] `bun install`
- [ ] `bun run check`
