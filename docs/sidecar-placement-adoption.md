# Sidecar placement: adoption plan for hub-authoritative assignment

CL-6283. Read-only inventory and design pass. Scope: should workbench move run
placement (which sidecar hosts which run) from sidecar-local filesystem
discovery to Interchange's `sidecar-allocation` subsystem, and how.

## 0. What "sidecar-local discovery" actually means today

Workbench has **two placement paths already, and they are architecturally
different**:

- **Exclusive placement** (`packages/sidecar-placement`, a `TenantConfig.sidecarPlacement`
  flag) already goes through the platform's allocation subsystem end to end:
  `workflow-allocation-service.ts` → `createSidecarAllocationReconciler` →
  a `SidecarProvisioner` (workbench wires a Docker provisioner in
  `apps/hub/src/index.ts`). This is hub-authoritative, durable, generation-fenced.
  It is used for **zero runs today** unless a tenant opts in — `packages/folded-runs`
  never calls it.
- **Shared placement** — every folded run (chats, tasks, routine occurrences;
  the entire bulk population per [[mock-is-the-spec]]-adjacent context) —
  goes through `sessionService.deploySingleStepAtHead` →
  `sidecarRouter.sendAgentDeploy`, which resolves a target via
  `addressIndex.get(agentAddress) ?? findSidecarForNewAgent(agentAddress)`.
  `findSidecarForNewAgent` (`vendor/intx/hub-sessions/src/ws/sidecar-handler.ts:3308`)
  is:

  ```
  for (const [ws, conn] of connections) {
    if (conn.identity.kind === "shared") return ws;
  }
  ```

  **It returns the first connected shared sidecar, full stop.** No load
  balancing, no capacity signal, no rotation policy. `addressIndex` is an
  in-memory `Map` on the hub process — not persisted anywhere.

- The **durable record of "what runs where"** for the shared pool lives on
  each sidecar's local disk: `apps/sidecar/src/workflow-deployment-record.ts`
  writes `${dataDir}/workflow-runs/<deploymentId>/deployment.json`, and on
  boot `apps/sidecar/src/index.ts` calls `deployRouter.restoreWorkflowDeployments()`
  (backed by `scanWorkflowDeploymentRecords`) **before** the hub connection
  opens. The hub's addressIndex is then rebuilt purely from whichever sidecar
  happens to reconnect and self-report its addresses (`getWorkflowAddresses`
  in `apps/sidecar/src/index.ts`). This is "sidecar-local filesystem
  discovery": the sidecar decides what it hosts, and the hub finds out
  after the fact.

This inventory treats "adopting the allocation subsystem" as **extending the
already-proven exclusive path to the shared/bulk path** — not building
something new from scratch.

## 1. Capability inventory

| Capability                                                 | Allocation reconciler (`vendor/intx/hub-sessions/src/sidecar-allocation/reconciler.ts`)                                                                                                                                                                                                                               | Current shared/bulk path                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement decision owner                                   | Hub, via a durable `SidecarAllocation` row (`status`: pending → provisioning → allocated → replacing/releasing → released/failed), advanced by `claimNextReconcilable`/`reconcile`                                                                                                                                    | Hub picks at deploy time via `findSidecarForNewAgent` (first-connected), never revisited; sidecar decides what it _keeps_ hosting via local disk                                                                                                                                              |
| Multi-sidecar                                              | Native: every allocation is bound to one `sidecarId` via a `SidecarProvisioner`; the model supports N provisioners/N sidecars from the start (`plugins.getProvisioner`)                                                                                                                                               | None for shared: `findSidecarForNewAgent` has no notion of more than one shared sidecar beyond "first in the connections map"                                                                                                                                                                 |
| Reconnect handling                                         | `handleDisconnect`/`handleConnected` start/clear a durable reconnect-grace window per exact `(allocationId, generation)`; `initialize()` on hub boot re-arms grace for every allocation still marked `allocated`                                                                                                      | Hub-side: `sidecarRouter`'s ordinary disconnect handling for shared connections (not inventoried here in depth — unverified whether shared-address routing has an equivalent grace window; the sidecar-side symmetric mechanism is `restoreWorkflowDeployments` on the sidecar's own restart) |
| Generation fencing                                         | Every allocation carries a `generation` counter; `bindReplacementSidecar`, `markAllocated`, etc. all take `expectedGeneration`/`expectedLeaseId` and CAS-fail on mismatch; `router.fenceAllocation(id, generation)` rejects stale-generation traffic at the transport boundary                                        | No generation concept for shared addresses; `addressIndex` is last-writer-wins per address string                                                                                                                                                                                             |
| Retry/backoff                                              | `scheduleRetry` with exponential backoff (`defaultRetryDelay`, capped at `MAX_RETRY_BACKOFF_ATTEMPT`=5, 30s ceiling), durable across hub restarts (`nextAttemptAt` persisted)                                                                                                                                         | None visible for shared deploy failures beyond whatever the caller (e.g. `folded-runs`) itself retries                                                                                                                                                                                        |
| Replace-on-failure                                         | `replaceAfterFailure`: on ensure/connect/init failure, either replaces the sidecar (`beginReplacement`) or, if `enableAutomaticReplacementRecovery` is false (the default), fails the allocation outright via `beginUnrecoverableRelease`                                                                             | None; a shared-sidecar deploy failure is the caller's problem                                                                                                                                                                                                                                 |
| Lease/liveness during long ops                             | `withLeaseHeartbeat` extends a `reconciliationLeaseId` every `leaseDurationMs/3` while `ensure`/`destroy`/`onReady` run, so a crashed reconciler's claim expires and another instance can pick it up                                                                                                                  | Not applicable — no reconciliation loop exists for shared placement                                                                                                                                                                                                                           |
| Auditability                                               | Every state transition is a row-level durable write (`SidecarAllocationStore`) with `failureCode`/`failureMessage` captured on `beginReplacement`/`beginUnrecoverableRelease`/`failWithoutInfrastructure`                                                                                                             | None: which sidecar a given run has ever lived on is not recorded; only the _current_ sidecar's local disk knows, and that's destroyed on reclaim                                                                                                                                             |
| Idempotent recovery of "who owns this" after a hub restart | `initialize()` walks `listActive()` and either re-arms a connection-lost timer or wakes a stalled reconciliation                                                                                                                                                                                                      | Sidecar self-reports (`restoreWorkflowDeployments` → `getWorkflowAddresses`); hub has no independent source of truth to cross-check against                                                                                                                                                   |
| Provisioner abstraction (spin up/down infra)               | `SidecarProvisioner.ensure`/`.destroy`, versioned (`apiVersion`, `bindingFingerprint`) so a changed provisioner binding fails closed rather than silently reusing stale infra                                                                                                                                         | N/A — shared sidecars are presumed always-on, pre-connected; nothing "provisions" them                                                                                                                                                                                                        |
| Automatic replacement of a lost worker                     | Exists as a code path (`beginReplacement`) but **disabled by default** — `enableAutomaticReplacementRecovery = false`. Reconciler comment: "Hub recovery does not restore arbitrary sidecar or isolation-container filesystem state, so automatic continuation could run without state the previous worker produced." | N/A                                                                                                                                                                                                                                                                                           |

## 2. Gaps

For each: what the reconciler does not cover, and whether it's ours to build
or an upstream gap.

1. **Load-balanced/rotating selection among multiple _shared_ sidecars.**
   The reconciler allocates one sidecar per _exclusive_ allocation; it has no
   concept of a pool of interchangeable shared sidecars serving many
   lightweight runs. Even fully adopting the allocation subsystem for folded
   runs (each folded run becomes its own `SidecarAllocation`, exclusive by
   construction) sidesteps rather than solves "pick the least-loaded of N
   sidecars" — `plugins.getDefaultProvisioner()` returns one provisioner, and
   `SidecarProvisioner.ensure` is the thing that would need to embed
   selection logic. **Ours to build**: a provisioner (or plugin-registry
   change) that scores/picks among live shared sidecars. Nothing in the
   vendored reconciler does this today, and I found no queueing/capacity
   primitive in `contracts.ts` to hang it off — this is a real gap, not
   something I simply didn't find.

2. **Portable run state across a sidecar replacement.** The reconciler's own
   doc comment says point-blank that Hub recovery does not restore "arbitrary
   sidecar or isolation-container filesystem state" — that's _why_
   `enableAutomaticReplacementRecovery` defaults off. Workbench already has
   a partial answer for this (the workflow-run pack push/restore pair,
   `apps/sidecar/src/workflow-run-pack-client.ts` /
   `workflow-run-pack-restore.ts`, wired in `apps/sidecar/src/index.ts` as
   `applyWorkflowRunPack: restoreWorkflowRunPack`) — the hub already holds a
   pushed copy of workflow-run history and can replay it into a fresh
   sidecar. But three things are NOT covered by that mechanism and are
   **ours to build or explicitly accept as loss**:
   - Per-step **agent-state repos** and **scratch dirs**
     (`workflow-step-state/<deploymentId>`) — these are reclaimed on
     ordinary teardown and, per the gtm-workbench CL-3104 patch's own
     comments, are exactly what a state-preserving teardown protects. I did
     not find an equivalent push/restore path for these in this repo; treat
     as **unverified whether any pack-style mechanism covers them** — grep
     turned up nothing, so flag as a likely gap rather than a confirmed one.
   - The **signing identity**. `apps/sidecar/src/index.ts` mints/loads one
     Ed25519 keypair per sidecar host (`loadOrMintSidecarKeypair`, persisted
     at `${dataDir}/.sidecar-signing`), and every deploy derives the run's
     principal public key from that seed
     (`derivePrincipalPublicKeyHex(signingKeySeed)` in
     `apps/sidecar/src/workflow-host-wiring/index.ts:151`), which the hub
     records as `workflowRun.publicKey`. **Verified in code**: the key is
     host-scoped, not deployment-scoped or portable. A different sidecar
     replacing the first has a _different_ seed and would derive a
     _different_ public key for the same run — this is a genuine identity
     discontinuity, not a hypothetical. Whether the platform tolerates
     re-deriving under a new key for the same `anchorRunId` (e.g. by
     updating `workflowRun.publicKey`) is **unverified** — I did not trace
     every reader of that column.
   - The **conversation state root** (`agent-conversation-state/`, called
     out explicitly as untouched by teardown's scratch reclaim) — same
     "no cross-sidecar copy exists" situation as agent-state repos above,
     same unverified-mechanism caveat.

3. **Tracing/auditability of _which_ sidecar served a run, historically.**
   The allocation store gives you this for exclusive allocations (every
   status transition is a row). For shared allocations there is currently
   no durable "run X was hosted on sidecar Y from t0 to t1" record at all —
   only the current sidecar's local `deployment.json` and the hub's
   in-memory `addressIndex`. Moving shared runs onto the allocation model
   gets this for free (it's a byproduct of the reconciler's existing
   durable state, not new work) — this is actually the strongest argument
   for the migration, not a gap.

4. **`enableAutomaticReplacementRecovery` staying off in production.** This
   isn't a gap to fill so much as a design decision to inherit: the
   reconciler's authors deliberately shipped this disabled because they have
   no general filesystem-state-portability story either. Turning it on
   for workbench requires _us_ to have solved gap #2 first. Flipping the
   flag without first solving portability would silently run agents forward
   with amnesia — worse than the current failure mode (a stuck allocation an
   operator can see and intervene on).

5. **The CL-3104 "resident-supervisor re-ack" pattern has no upstream/vendor
   counterpart.** Confirmed via the gtm-workbench reference repo: this is a
   WORKBENCH-LOCAL patch (`docs/VENDORED.md` there: "Upstream's
   `agent.undeploy` protocol has no hibernate reason/flavor; the
   state-preserving teardown this implements has no upstream counterpart at
   this pin," `keep-with-reason`). It solves a **different problem than
   placement**: a hub retrying `agent.deploy` at an address whose child is
   still alive (a failed hibernate-ack, or a hub restart that dropped
   `addressIndex`) used to trigger teardown+respawn, which routinely blew
   past the hub's 30s deploy timeout under concurrent warm-path deploys. The
   fix re-announces the existing live child's key instead of killing and
   respawning it. This is orthogonal to _where_ placement decisions live —
   it's about not needlessly destroying a resident worker when the hub's
   own bookkeeping is stale. **Genuinely relevant to goal (e)** (see §5) but
   it is a sidecar-boot-scoped optimization, not itself a placement-authority
   change, and workbench does not currently carry this patch (grep of this
   repo for "3104"/"resident-supervisor" found nothing) — this is new work
   for our tree, borrowed by pattern rather than by vendoring code, since it
   modifies a WORKBENCH-LOCAL divergence in a different repo, not shared
   Interchange code.

## 3. Migration sequence

Invariant to hold at every step: **placement of a given run is owned by
exactly one of {hub, sidecar} at a time.** Never split-brain — a run must
never be simultaneously "the sidecar decided to keep this resident" and
"the hub allocation reconciler thinks it owns this."

1. **Ship 1 — instrument, change nothing.** Add a durable "which sidecar
   served this run" log for shared deploys (append-only, hub-side, written
   at `sendAgentDeployOnConnection` success). This is pure observability —
   no placement authority moves. Gives a baseline to compare against once
   migration starts, and directly buys back the auditability half of gap #3
   without touching the allocation subsystem yet.

2. **Ship 2 — make the shared pool resolve through a real selector, still
   sidecar-owned residency.** Replace `findSidecarForNewAgent`'s
   first-connected-wins with an actual policy (round-robin or
   least-loaded by connected-address count) purely on the hub's
   `sidecarRouter` — this is a hub-side change but does not touch the
   allocation reconciler at all, and does not change who decides to _keep_
   a run resident (still the sidecar, via its local `deployment.json`).
   This alone gets goal (b) "multi-sidecar easily" most of the way there
   for new deploys, with the smallest possible blast radius, and is
   independently valuable even if the rest of this plan stalls.

3. **Ship 3 — route ONE class of folded run through
   `WorkflowAllocationService.prepareExclusiveDeployment` as a pilot,**
   e.g. workbench's own host runs (already flagged via
   `packages/sidecar-placement`, already exercised in production for that
   tenant flag). This validates the "every folded run is an allocation" model
   end to end on real traffic without migrating the bulk of runs. At this
   point that pilot's placement is 100% hub-owned; the sidecar-local
   `deployment.json` record becomes redundant for that specific class (but
   keep writing it — do not remove the sidecar's own bookkeeping until
   Ship 5's cutover, so a rollback is just "stop calling the allocation
   service").

4. **Ship 4 — build the missing multi-sidecar-aware provisioner (gap #1)**
   for the _shared_ pool: a `SidecarProvisioner` whose `ensure` picks among
   already-connected shared sidecars by a real load signal instead of
   spinning up new infra (unlike the Docker provisioner, which provisions
   fresh containers — this provisioner's "ensure" is "pick and claim an
   existing connection"). This is new code with no vendor equivalent.
   Ship behind a flag, dark-launch against a shadow allocation stream (not
   yet authoritative) to compare its choices against Ship 2's, before
   flipping it live.

5. **Ship 5 — the cutover.** Flip folded-run launch (`launch.ts`) and wake
   (`wake.ts`) to call `prepareExclusiveDeployment` + wait for
   `deployReadyAllocation` instead of `sessionService.deploySingleStepAtHead`
   directly, for all new launches. **This is the exact moment placement
   authority moves from sidecar to hub for the bulk population.** From this
   commit forward:
   - The sidecar's `restoreWorkflowDeployments`/`scanWorkflowDeploymentRecords`
     boot path must stop being consulted for placement of newly-created
     runs — only for a fixed, shrinking cohort of pre-cutover runs still
     using the old path, until they naturally terminate or are migrated.
   - Do this as a single atomic flag flip, not a partial rollout across
     run classes, specifically because addressIndex (hub, in-memory,
     first-writer-wins) and the allocation store (hub, durable,
     generation-fenced) must never both claim the same address
     concurrently — a run whose address exists in both would have two
     sources of truth disagreeing about which sidecar is authoritative.
   - Keep the old path's code intact but unreachable behind the flag for
     one full release cycle, in case of rollback.

6. **Ship 6 — retire the sidecar-local discovery path** once every run
   created before cutover has settled (terminated) or been forcibly
   migrated. Delete `scanWorkflowDeploymentRecords`'s call site from boot
   (or repurpose it purely as a crash-recovery reconciliation input the hub
   cross-checks against its own allocation rows, rather than a primary
   source of truth) and remove `findSidecarForNewAgent`.

Do NOT attempt gap #4 (`enableAutomaticReplacementRecovery: true`) as part
of this sequence — it is gated on solving portability (§4 below), which is
open-ended and should be its own follow-up, not bundled into the placement
migration.

## 4. Rotation and multi-sidecar: what must become portable

| State                                                                                    | Portable today?                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Signing/identity keypair                                                                 | **No — machine-pinned.** One Ed25519 seed per sidecar host, persisted at `${dataDir}/.sidecar-signing`, loaded once at boot (`apps/sidecar/src/index.ts`). Every run's principal public key is derived from it.                                                                                                                                                                                                            | `loadOrMintSidecarKeypair`, `derivePrincipalPublicKeyHex(signingKeySeed)`                                   |
| Deployment record (`sources`, `sessionId`, `hubPublicKey`, referenced-definition hashes) | **No — local disk only**, but small and reconstructible from the hub's own launch-spec store (`createWorkflowRunLaunchSpecStore`, used by `workflow-allocation-service.ts`'s `deployReadyAllocation` to rebuild an equivalent config from durable hub state). For the _exclusive_ path this is already durable hub-side. For the _shared_ path (`workflow-deployment-record.ts`) it exists **only** on the sidecar's disk. | `workflow-deployment-record.ts` header comment; `deployReadyAllocation` in `workflow-allocation-service.ts` |
| Workflow-run repo (event log)                                                            | **Partially portable.** Sidecar-local disk is the live copy, but packs are pushed to the hub as they're written (`workflow-run-pack-client.ts`) and can be replayed into a fresh sidecar (`applyWorkflowRunPack`/`restoreWorkflowRunPack`, wired at boot). This is the one piece of state workbench has already solved the portability problem for.                                                                        | `apps/sidecar/src/index.ts` boot wiring                                                                     |
| Per-step agent-state repos / grants                                                      | **Unverified, likely not portable.** No pack/push equivalent found for these; CL-2231/CL-3104 (gtm-workbench) both treat them as sidecar-local and reclaim-on-teardown.                                                                                                                                                                                                                                                    | grep of this repo found no restore path; flagged, not assumed                                               |
| Per-step scratch (`workflow-step-state/<deploymentId>`)                                  | **No.** Explicitly local, explicitly reclaimed on teardown, explicitly gated off only for hibernate (same host) in the gtm-workbench patch — never designed to move hosts.                                                                                                                                                                                                                                                 | `workflow-deployment-record.ts`, gtm-workbench `teardownDeployment`                                         |
| Durable conversation state (`agent-conversation-state/`)                                 | **Unverified, likely not portable.** Explicitly called out as a separate root untouched by scratch reclaim, but no cross-sidecar copy mechanism found.                                                                                                                                                                                                                                                                     | gtm-workbench comment: "a DIFFERENT root and is deliberately NOT touched here"                              |

**What this means for `enableAutomaticReplacementRecovery`:** turning it on
is gated on making at least the identity keypair and the per-step
agent-state/scratch/conversation roots portable — today only the
event-log/pack half of "resume elsewhere" exists. Recommendation: do not
enable it as part of this migration. Rotation ("easily rotate sidecars")
should instead mean, near-term, _graceful drain_ (stop assigning new runs to
a sidecar, let its resident runs finish naturally, then take it down) rather
than _forced mid-run replacement_ — drain is achievable purely with the
Ship 2/5 selection logic and needs none of the portability work above.
Forced replacement of an in-flight run is a larger, separate investment and
should not block the placement-authority migration.

## 5. Scale check against goal (e): "pushing updates must not redeploy a million workflows"

At small scale (hundreds–low thousands of parked/resident runs), the current
per-address, per-connection model (`connections: Map<WsHandle, SidecarConnection>`,
`addressIndex: Map<string, WsHandle>`) is fine — these are cheap in-memory
maps.

At **10k parked runs**: still fine on the data-structure side. The concern
shifts to the reconciler's polling loop if the shared pool moves onto
allocations wholesale: `reconcileUntilIdle` runs every
`ALLOCATION_RECONCILIATION_INTERVAL_MS` (1s, per `apps/hub/src/index.ts`)
and processes up to `maxIterations` (default 100) allocations per tick via
`claimNextReconcilable`. 10k allocations that are all quietly `allocated`
and connected do **not** get reconciled repeatedly — the reconciler only
claims rows that are due (`nextAttemptAt` reached, or freshly woken). So
steady-state resident runs are cheap; the cost is concentrated at
**mass-wake events** (a deploy that touches every resident sidecar, or a hub
restart that calls `initialize()` and marks every `allocated` row
connection-lost).

At **100k**: `initialize()` iterates `listActive()` — a single unbounded
query and loop over every active allocation on hub boot. This is the first
real bottleneck: no batching visible in `reconciler.ts:536-558`. A boot with
100k active allocations does 100k `markConnectionLost`/`wakeReconciliation`
calls synchronously in one async function, each a DB write. This needs
batching (chunked concurrency, not one-row-at-a-time serial awaits) before
100k is safe — **unverified whether `allocationStore.listActive()` itself
paginates**; if it returns all 100k rows as one array, that's a memory
concern too, though a modest one (allocation rows are small).

At **1M**: goal (e) specifically calls out "pushing updates in production
must not redeploy a million workflows on start." The CL-3104
resident-supervisor re-ack pattern is the more relevant lever here than the
allocation model itself: on a sidecar restart (a code push), the _cheapest_
possible outcome is "nothing redeploys, existing children just get
re-acked in place" — but that only works when the sidecar process itself
didn't restart, only the hub's routing table did. A genuine sidecar restart
(the actual "pushing updates" case) kills every resident child on that box
regardless of placement model — allocation-based or not — because the
workflow-process children are OS subprocesses of that sidecar. **The
allocation model does not solve goal (e) by itself.** What it buys at 1M
scale is: (a) the hub can restart independently of the reconciliation
being redone from scratch (durable state survives a hub restart, per
`initialize()`), and (b) a _rolling_ sidecar deploy (bring up new sidecar
processes, drain old ones via Ship 2's selector, never touch resident
children on old sidecars until they finish or are force-migrated) becomes
possible in a way it structurally is not today, because today there's no
hub-side notion of "which sidecar to stop sending new work to" beyond
disconnecting it. **Bottleneck at 1M is the mass-transition write volume**
(1M allocation-row updates on any global event) — this needs either sharding
the reconciliation loop or accepting that a full-fleet event is inherently a
background job measured in minutes, not a boot-blocking step. That
acceptance itself may be the right call: it's what the _current_ design
already implicitly assumes (a sidecar reconnecting streams its addresses
back in over time via `getWorkflowAddresses`, not synchronously).

## 6. Risks (ranked)

1. **Split-brain placement authority during the Ship 5 cutover.** If any
   code path can still write to the old `addressIndex`/local-disk model for
   an address that the allocation store also believes it owns, two sidecars
   could both believe they host the same run, corrupting the workflow-run
   repo (two children writing to one substrate — exactly the failure mode
   the gtm-workbench CL-3104 comment calls out: "two children drive one
   workflow-run repo"). Mitigation: the atomic single-flag cutover in Ship 5,
   not a gradual per-run-class rollout.

2. **Enabling `enableAutomaticReplacementRecovery` before portability is
   solved.** Would silently run a workflow forward on a fresh child with no
   memory of the torn-down worker's scratch/agent-state/conversation —
   worse than today's failure mode (a visible stuck allocation). This is a
   real temptation once the allocation model is in place for the bulk pool,
   because it looks like "just flip the flag" — it isn't.

3. **Identity discontinuity on any cross-sidecar move.** Because the
   principal public key is derived from the sidecar host's own seed, any
   scenario that moves a run's execution to a different sidecar (rotation,
   forced replacement, or even an operator manually re-pointing a
   deployment) changes that run's recorded public key. If any downstream
   consumer treats `workflowRun.publicKey` as an immutable identity anchor
   rather than a rotatable field, this breaks silently. Needs verification
   before Ship 4/5, not after.

4. **Reconciliation-loop overload on a mass event at scale.** `initialize()`'s
   unbatched full-table walk (§5) becomes a hub-boot latency or DB-load
   problem well before 1M rows if the bulk pool is fully migrated onto
   allocations. Should be load-tested at a representative fraction of target
   scale before Ship 5, not discovered in production.

5. **Building the multi-sidecar-aware provisioner (gap #1/Ship 4) badly.**
   This is the one piece of this plan with no existing pattern to copy —
   the Docker provisioner in this repo spins up new infrastructure, it
   doesn't select among existing shared connections. Getting the load
   signal wrong (e.g. naive round-robin under wildly uneven run weight)
   could concentrate load anyway. Recommend shadow-mode comparison against
   Ship 2 before it's authoritative (called out in Ship 4 above).

## Conclusion: is the full migration worth it?

Yes for placement _authority and auditability_ (Ships 1–3, arguably 5) —
the durability and generation-fencing workbench would inherit is real and
currently entirely absent for the bulk population. **No, not yet, for
automatic replacement recovery** — the portability prerequisites (identity,
agent-state, scratch, conversation) are not solved anywhere in this
codebase or the reference implementation, and enabling it prematurely
trades a visible failure mode for a silent one. Treat Ships 1–3 as the
near-term deliverable, Ships 4–6 as the real migration, and the CL-3104-style
resident-supervisor pattern plus automatic replacement recovery as separate,
later efforts gated on work this plan does not include.
