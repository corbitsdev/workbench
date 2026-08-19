# CL-5514 re-vendor: pin delta, breakage, retirement

> Superseded pin: CL-6254 bumped the vendored tree from `55c4431e` to
> `59f5e7b9` (upstream `main` tip, 2026-08-18). `VENDORED.md` is the current
> pin of record; every `55c4431e` reference below is historical. The bump
> added upstream's source-format workflow line and cost one contract
> adoption (`applyAtomic` now takes `gitDirs`); the retirement verdicts below
> still hold — nothing in it retires `packages/folded-runs`,
> `packages/agent-lifecycle`, or the self-anchoring mechanism.

This has since landed for real: all five breakage items below are fixed on
`cl-5514-revendor`, the branch merged the `cl-5879-shell-mock-v2` shell/plugins
work forward onto the new pin, and `bun run check` plus a full walkthrough run
green against it. What follows is the historical record of what the re-vendor
pass found, kept as the rationale for the fixes and for the retirement
verdicts below — not a still-open remediation list.

## Pin delta

|                                            | Commit                                     | Date                                               |
| ------------------------------------------ | ------------------------------------------ | -------------------------------------------------- |
| Old pin (`VENDORED.md` before this change) | `26ae23e8`                                 | tip of upstream's now-merged `intr-358-...` branch |
| New pin                                    | `55c4431e60cc97dae2f63bfd52de56166e42b13b` | upstream `main` tip, 2026-08-15                    |

95 commits landed on upstream `main` between the two pins. The old pin was
itself a branch-tip pin (see the removed paragraph in `VENDORED.md`) explicitly
waiting for `intr-358-dissolve-the-workflow_deployment-cache-and-re-anchor-onto`
to merge into `main`; it has, so this re-pin is a plain main-tip bump rather
than a branch re-target.

Ground commits confirmed present on `main` since the old pin:

- `e2732d32` "Collapse the workflow deployment onto one self-anchored run" —
  the PR #130 change the ticket asked to verify.
- `db42bf3e` "Anchor every source-ref deployment with a workflow_run row" —
  isolated-workflow anchoring (PR #123 territory).
- `a3b90e69` "Deliver credential material on the source-ref deploy frame",
  `16a4a2d7` "Migrate the workflow-definition tables to content-hash identity" —
  credential delivery / definition-identity work (PR #125-127/#132 territory).
- `b5c1525b` "Retire the folded agent-instance launch route",
  `bb323d9a`/`cbe00ec2`/`b3ea566d`/`f9893011` — rename deployment/instance
  identity to run-first, `anchor_run_id`.
- `ed1bc056`/`a8f44e98` — xAI Grok model catalog additions.
- Durable suspend/resume (PR #97-101 territory) landed **before** the old pin
  — nothing new there since 26ae23e8; the closest post-pin work is the
  source-ref body-ref pinning series (`55c4431e`, `6531c929`, `e1fffb32`,
  `db42bf3e`, …), which extends the same suspend/resume machinery to
  code-sourced (non-asset) workflow bodies.

No newer PR beyond what the ticket named was found to be load-bearing for
workbench; the tail of the 95 commits is xAI catalog additions, run-first
renames, and the source-ref body-ref pinning series above.

## Re-vendor mechanics

All 20 `vendor/intx/*` packages were re-copied from upstream `packages/*` at
`55c4431e`, following the existing convention: `src/`, `package.json`,
`tsconfig.json`, `README.md`, `CONVENTIONS.md` (+ `migrations/`,
`drizzle.config.ts`, `tsconfig.config.json` for `db`) synced, then:

- `package.json` exports repointed from the upstream `intx-src` condition to
  direct source resolution (`types`/`default` → `./src/...`), `files: dist`
  → `files: src`.
- `tsconfig.json` `extends` path adjusted for the shallower vendor tree
  (`../../tsconfig.base.json` → `../tsconfig.base.json`).
- `tsconfig.base.json`'s `customConditions: ["intx-src"]` entry dropped.
- `harness` still drops the unvendored `@intx/inference-testing`
  devDependency.
- `hub-api` still adds the `@types/ssri` devDependency and still excludes the
  reserved `needs-you` segment from its `:approvalId` param routes
  (`vendor/intx/hub-api/src/routes/approvals.ts`) — reapplied by hand since
  the route file itself was re-copied wholesale from upstream.
- **New this pass:** `hub-agent`'s upstream `package.json` picked up a
  `@intx/test-harness` devDependency (`tests/lib` upstream, not a `packages/*`
  entry we vendor). Dropped it under the same precedent as
  `harness`/`@intx/inference-testing`. This orphans
  `vendor/intx/hub-agent/src/ws/hub-link.test.ts`'s import of
  `@intx/test-harness` — see breakage below.

`VENDORED.md` and `scripts/checks/kill-dates.txt` both updated: new pin,
renewed kill date (2026-09-14, +30 days from today), and recomputed sha256
tree hashes so `check:killdates` passes clean.

## Breakage inventory (one full `bun run typecheck`)

Five distinct root causes, surfacing across 7 workspace packages:

### 1. `WorkflowDefinitionSelector` now requires a wire hash, not just an asset id

**Cause:** semantic. `16a4a2d7` ("Migrate the workflow-definition tables to
content-hash identity") changed `WorkflowDefinitionSelector` in
`vendor/intx/db/src/workflow-definition-store.ts:19-22` from a bare
`assetId: string` to `{ assetId: string; wireHash: string }` — "a single
asset backs many definitions distinguished by their wire hash." The vendored
helper `ensureWorkflowDefinitionForAsset` in
`vendor/intx/hub-sessions/src/workflow-definition-ensure.ts:34-37` now takes
that selector object instead of a bare string.

**Breaks (all pass a bare asset-id string):**

- `apps/hub/src/index.ts:1654`
- `packages/agent-directory/src/routes.ts:284`
- `packages/chat/src/platform-adapter.ts:340`

**Cascades** (typecheck depends on the packages above) into
`@corbits/task-planner`, `@corbits/slack-tag`, `@corbits/chat`,
`@corbits/tasks`, `@corbits/agent-directory`.

**Fix shape:** semantic. Each of the 3 call sites needs to produce a
`wireHash` for the workflow JSON it just wrote (upstream's wire-definition
hash helper, promoted in `3514d6c4`, is the natural source) and pass
`{ assetId, wireHash }` instead of the bare id.

### 2. `createIsogitStore` is no longer a top-level export — it's a bound method off a runtime-injected storage object

**Cause:** semantic. `5f798bea`/`c3e160d8`/`70a81df6` restructured
`@intx/storage-isogit` so a filesystem `IsogitRuntime` is injected once via
`createIsogitStorage(runtime)` (`vendor/intx/storage-isogit/src/index.ts:59-96`),
which returns an object exposing `createIsogitStore` (and everything else)
bound to that runtime. There's no more bare `createIsogitStore` export; the
Node-side runtime is available via `createNodeIsogitRuntime()` /
`runtime` in `vendor/intx/storage-isogit/src/node.ts`.

**Breaks:**

- `apps/sidecar/src/conversation-state.ts:131,312`
- `apps/sidecar/src/workflow-substrate-factory/step-env.ts:13,256`

**Fix shape:** mechanical-plus. Import `createNodeIsogitRuntime` from
`@intx/storage-isogit/node`, call `createIsogitStorage(createNodeIsogitRuntime())`
once, and call `.createIsogitStore(dir, signer, gcPolicy)` on the result at
both call sites. No new plumbing needed since a Node runtime is a stable
singleton — just an import + call-site rewrite.

### 3. Spawning a suspendable child now requires a `referencedDefinitionHashes` map

**Cause:** semantic. Part of the source-ref body-ref pinning series
(`db42bf3e` and its followers through `55c4431e`).
`WorkflowSpawnSuspendableChildOpts` in
`vendor/intx/workflow-host/src/adapters/spawn-child.ts:277-311` now requires
`referencedDefinitionHashes: Record<string, string>` — "the parent's signed
deploy frame['s]... `SpawnTimeEnv.referencedDefinitionHashes`" — used to
re-verify a spawned child body's definition hash against what the parent's
deploy actually approved.

**Breaks:**

- `apps/sidecar/src/workflow-substrate-factory/index.ts:591`
  (`createWorkflowSpawnSuspendableChild({...})` call, missing the new field)

**Fix shape:** semantic. The sidecar's `SpawnTimeEnv` needs the
`referencedDefinitionHashes` map threaded from wherever the sidecar receives
its deploy frame at boot (mirrors how `deployRef` already gets there) down
into this call. Not a local one-line fix — needs the boot-time deploy frame
plumbing traced and extended.

### 4. `hub-agent`'s dropped `@intx/test-harness` devDependency orphans a test import

**Cause:** mechanical (vendoring-boundary fallout, not an upstream API
change). `vendor/intx/hub-agent/src/ws/hub-link.test.ts` imports
`@intx/test-harness`, which now only exists as `tests/lib` upstream (not a
`packages/*` entry, so not something this ledger vendors). Dropping the
devDependency (same precedent as `harness`/`@intx/inference-testing`) leaves
that one test file with a dangling import.

**Not surfaced by `bun run typecheck`** at the app/package level because bun
in this repo doesn't typecheck vendored packages' own test files as part of
consumer builds — but `tsc -p vendor/intx/hub-agent` would fail on it
directly. Flagging it here since it's a direct consequence of this pass.

**Fix shape:** mechanical. Either delete/adapt that one test (matching how
other retired-dependency test fallout gets handled), or extend the ledger to
also vendor `tests/lib` as `@intx/test-harness` if the test is worth keeping.

## Retirement list verdicts

Evidence gathered by a parallel research pass over both repos (workbench
`packages/`/`apps/`/`workflows/` vs. interchange commits since `26ae23e8`).
7 of the 14 tickets had no findable workaround code under the names/CL
numbers searched — flagged as NOT FOUND rather than guessed at.

| Ticket / workaround                                                                                                                               | Verdict                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-anchoring, `packages/folded-runs/launch.ts` + marker table + `reconnect.ts`                                                                  | **CHANGED (confirmed, not retirable)**     | Post-merge check against the landed `55c4431e` pin: `vendor/intx/hub-sessions/src/hub-session-lookups.ts:374` still gates `receiveWorkflowRunPack` on `anchor.anchorRunId === anchor.id` — the exact check self-anchoring exists to satisfy — so the mechanism itself is still required, not just the doc citation. The dead citation is fixed: `packages/folded-runs/src/launch.ts`'s header comment pointed at `vendor/intx/hub-api/src/routes/instances.ts` (deleted by `b5c1525b`); the route moved to `vendor/intx/hub-api/src/routes/runs.ts`, confirmed still self-anchoring at line 291/307/840, and the comment now cites that file with a note on the rename. The marker table (`packages/folded-runs/src/schema.ts`) and `reconnect.ts`'s `lookupFoldedRunReconnectKey` patch are both still needed — upstream has no per-chat-launch concept and its `isLiveWorkflowRunStatus` reconnect gate is unchanged since the old pin. Nothing here was deleted; this is a doc-accuracy fix only. |
| Chat write-claims (`packages/chat/src/write-claims.ts`, CL-6039)                                                                                  | **STILL-OPEN**                             | Redelivery-dedup via `tryClaim`/`release` (`write-claims.ts:24-49`) has no upstream equivalent; no dedup/idempotency commits touching this surface since the pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tasks chain in-process hand-off (`packages/tasks/src/chain.ts:1-27`, CL-6059/6060)                                                                | **STILL-OPEN**                             | Comment cites two blockers: dispatch needs a `sidecar_allocation` row never minted for folded runs, and `buildRuntimeEnv` never binds `invokeAction`. Confirmed still true in `vendor/intx/workflow-host/src/child/run-child.ts` and `vendor/intx/workflow/src/runtime/env.ts` — `invokeAction` remains unbound; no dispatch-allocation-gating commits since the pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Skills consumption (CL-6021)                                                                                                                      | **NOT FOUND**                              | No "CL-6021" or comparable marker in `packages/skills` / `packages/tools-skills`; likely workbench's own feature build, not a documented upstream-gap workaround.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Approvals scope always (CL-5956)                                                                                                                  | **NOT FOUND**                              | No "CL-5956", `approvalScope`, or "scope: always" workaround found anywhere in the worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Asset delete (CL-6040)                                                                                                                            | **NOT FOUND**                              | No "CL-6040", `deleteAsset`, or asset package at all in the worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Tenant-mint gating (`apps/hub/src/tenant-create-guard.ts`, CL-6041)                                                                               | **STILL-OPEN**                             | Wraps the native `POST /api/tenants` because it's ungated; `git log 26ae23e8..origin/main -- packages/hub-api/src/routes/tenants.ts` upstream shows zero commits — route unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| IDKind task (`packages/tasks/src/launcher.ts:264-269`, CL-6056)                                                                                   | **STILL-OPEN**                             | Upstream `vendor/intx/hub-common/src/ids.ts` `PREFIXES` map still has no `task` entry; workbench still hand-rolls `mintTaskId()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `receiveWorkflowRunPack` anchors (`packages/folded-runs/src/launch.ts:240-247`, CL-6044)                                                          | **STILL-OPEN mechanism / CHANGED context** | Upstream `vendor/intx/hub-sessions/src/hub-session-lookups.ts:369-373` still requires `anchor.anchorRunId === anchor.id` before accepting a pack — same check the workaround targets. But per `e2732d32`'s commit message, the folded-launch surface it mimics (stop, mail send/history, turns, event stream) is being retired upstream in favor of run-first surfaces — the ground workbench stands on is shifting even though the specific check hasn't.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Mail-trigger anchor (CL-6020)                                                                                                                     | **NOT FOUND**                              | No "CL-6020" or comparable mail-trigger-anchor workaround found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Abort race (CL-5960)                                                                                                                              | **NOT FOUND**                              | No "CL-5960" or abort/race workaround found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Self-update grants (`packages/agent-directory/src/workflow-capability-routes.ts:16-40`, `packages/capability-tools/src/client.ts:14-22`, CL-6085) | **STILL-OPEN**                             | A run's own `kind: "workflow"` principal is never seeded a `workflow-definition:<own id>/update` grant; upstream's `715c8be6` (removes unenforced approved-grant shipment) and `09d4cfd1` (freezes per-deployment grant walk) don't add own-definition self-update grant materialization — unrelated to this gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tool-id binding (CL-6034)                                                                                                                         | **NOT FOUND**                              | No "CL-6034" or tool-id-binding workaround found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Audit API (CL-6025)                                                                                                                               | **NOT FOUND**                              | No "CL-6025" or dedicated audit-log workaround found; only generic, unrelated `audit` string hits in logging/telemetry code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Open upstream gaps patched in the vendored tree

Fixes carried locally in `vendor/intx/*` because no published `@intx/*` covers
them. Each one is a candidate to drop on the next re-pin — check the upstream
code first, then delete the local delta and its note in `VENDORED.md`.

### Terminal anchors could not consume their own in-flight mail

`vendor/intx/hub-sessions/src/hub-session-lookups.ts` —
`receiveWorkflowRunPack`

Upstream gated the anchor lookup on `liveWorkflowRunStatuses`
(`deployed | running`), so once a run went terminal the hub refused every
pack pushed from that run's own address with `path_violation`. Two writes a
terminal run legitimately still owes both live behind that gate:

- `enqueueInbox` for mail that arrived during the teardown window, and
- `markConsumed` carrying the `workflow_run_terminal` rejection that retires
  such mail (`workflow-host/src/supervisor/supervisor.ts:2061`).

Neither can land, so the sidecar withholds the ack, the hub redelivers, and
the pair spins forever — observed as this trio repeating every ~10s against a
finished workbench run:

```
WRN  hub·lookups: Workflow-run pack rejected for <run>: source address has no live deployment anchor
WRN  workflow-host·supervisor: rejecting inbound mail <id>: workflow run <run> is terminal
ERR  workflow-host·supervisor: dispatch loop iteration failed: failed to markConsumed for run <run>
```

**Local fix:** the live-status filter is gone; ownership is the exported pure
helper `ownsWorkflowRunRepo` — a self-anchored `workflow_run` row with a
routable address. The `sidecar_allocation` generation/ownership fences below
it are untouched, so who may write is unchanged; only _when_ relaxes.
Accepting a post-terminal pack is safe because the substrate's per-commit
walk yields no new terminal events for an already-settled run. Covered by
`vendor/intx/hub-sessions/src/hub-session-lookups.test.ts`.

**Retire when** upstream either accepts consume-only writes from a terminal
anchor, or stops delivering mail to a terminal run instead of redelivering it.

### An event-only mail killed the run it was delivered to (CL-6164)

`vendor/intx/workflow-host/src/supervisor/supervisor.ts` — the dispatch loop's
`signal.deliver` branch

Attachments-only mail is legitimate on the bus: `@corbits/chat`'s `encodeParts`
leaves `content` empty for an event-only send, so a `workbench.agent-joined`
post is a `conversation.message` whose `text/plain` part is empty and whose
payload is a JSON attachment. `extractConversationText` returns `""` for it,
and upstream delivered that `""` as the resume payload. Downstream,
`step-invoker.ts` hands it to `agent.send`, which throws
(`createInboundMessage: content, when provided, must be a non-empty string`) —
surfacing as `StepFailed` with `retriesExhausted`, then `RunFailed`.

Workbench already knew this hazard and had closed the **turn-1** door:
`packages/chat/src/platform-adapter.ts`'s `WORKBENCH_HOST_STEP_INPUT` pins the
workbench-host step's input to a literal so `trigger.payload` can never carry
an empty body into `agent.send`. The **turn-2+** door was still open, because
the parked-resume path never consults the step's `input` selector — the
supervisor extracts the text from the mail itself. Observed shape, a workbench
anchor dead 676ms after start because someone joined its bench:

```
StepStarted    input: inline:"workbench-host anchor turn"
SignalAwaited  __signal__:corr-1-...  parkKind: input
SignalReceived payload: ""
StepFailed     createInboundMessage: `content`, when provided, must be a non-empty string   retriesExhausted
RunFailed      one or more steps failed
```

Every later chat message then mailed a terminal run, which is what produced the
`path_violation` redelivery loop above — the two gaps compound.

**Local fix:** mail whose extracted body has no text is dropped and consumed
with an `empty_conversation_content` rejection, exactly as the adjacent
malformed-mail branch already does, instead of being delivered. The gate is the
pure helper `hasConversationText` in `workflow-host/src/conversation-text.ts`,
covered by `conversation-text.test.ts` against a fixture built to `encodeParts`'
real event-only shape.

**Retire when** upstream drops or otherwise guards empty-body mail on the
resume path. Two adjacent issues this surfaced, neither patched here: the same
mail was delivered twice under one `signalId` 110ms apart (a single mail can
resume a parked run twice), and `run-child.ts`'s turn-1 `resolveTriggerPayload`
still has the unguarded extraction — harmless for workbench only because of the
pinned literal above, but live for any workflow using the default selector.
Worth reporting alongside the adjacent question this surfaced: an anchor run
whose status flips terminal while its deployment stays mounted and its
workbench stays the active chat surface is what generates the in-flight mail
in the first place.

**On the 7 NOT FOUND items:** the workaround may live under a name not
guessed here, may not have landed yet, or the ticket may describe a gap with
no code-side mitigation to retire. Recommend re-running this check against
the actual Linear ticket bodies before concluding they're stale — this pass
searched by inferred keyword/CL-number, not by reading each ticket.

## Estimated fix effort

| Item                                                                                                                                                       | Shape           | Rough size                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowDefinitionSelector` wire-hash threading (3 call sites + cascading typecheck in 5 more packages)                                                   | Semantic        | Half day — need to source/compute a wire hash at each of 3 sites; the cascading packages need no code changes, just the root fixed.                             |
| `createIsogitStore` → `createIsogitStorage().createIsogitStore`                                                                                            | Mechanical-plus | 1-2 hours — 2 files, straightforward import + call-site rewrite.                                                                                                |
| `referencedDefinitionHashes` threading through sidecar's `SpawnTimeEnv`                                                                                    | Semantic        | 1-2 days — needs the sidecar's boot-time deploy-frame plumbing traced and extended; the riskiest item here since it touches trust-sensitive spawn verification. |
| `hub-agent` test-harness fallout                                                                                                                           | Mechanical      | Under an hour — delete or adapt one test file.                                                                                                                  |
| **Total to a green `bun run check`**                                                                                                                       |                 | **~2-3 days**, dominated by the `referencedDefinitionHashes` plumbing.                                                                                          |
| Retirement follow-through (closing STILL-OPEN items is out of scope here; CHANGED items need their workaround comments/reference-file citations refreshed) | —               | Separate ticket-by-ticket work, not part of this dry run.                                                                                                       |

This pass reduces vendored _code volume_ only modestly (no upstream package
was fully retired this cycle — the un-vendoring checklist in `VENDORED.md`
still applies to all 20 rows), but it does close the gap to the run-first /
self-anchored-run model the workbench-side workarounds were built against,
which is where the eventual retirement payoff sits once the STILL-OPEN items
above get their own passes.
