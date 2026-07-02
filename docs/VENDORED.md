# Vendored Interchange Code

This repo vendors (copies) some Interchange (`faremeter/interchange`, `@intx/*`)
code into our tree so we can change behavior the upstream packages don't expose a
seam for — without editing the `interchange/` submodule. Every divergence from the
upstream original is tagged with a `// WORKBENCH-LOCAL (CL-XXXX)` comment.

**Audit handle:** `git grep "WORKBENCH-LOCAL (CL-" -- apps/sidecar packages/workflow-host packages/storage-isogit`
lists every divergence in one pass. Run it before and after an interchange pin
bump and confirm no block disappeared. The re-sync process (diff each vendored
file against the new upstream, re-apply upstream changes _while preserving every
`WORKBENCH-LOCAL` block_) is documented in `AGENTS.md` → "Dockerfile Maintenance"
and "Vendored workflow-host wiring (pin-bump gate)".

There are two kinds of vendoring:

1. **Vendored files** copied from interchange's reference `apps/sidecar` into our
   `apps/sidecar` (the supervisor wiring is not packaged in any `@intx/*`).
2. **Vendored packages** — a full local copy of an `@intx/*` package under
   `packages/`, which our code imports instead of the upstream one.

---

## Vendored packages

### `packages/workflow-host` → `@workbench/workflow-host`

- **Added:** 2026-06-27 (CL-2535)
- **Vendors:** `@intx/workflow-host` (verbatim copy of `interchange/packages/workflow-host`).
- **Imported by:** `apps/sidecar` only (`bin/workflow-child`, `src/workflow-host-wiring.ts`,
  `src/workflow-substrate-factory.ts`, and their tests). `apps/hub` and
  `packages/hub-agent` intentionally stay on `@intx/workflow-host`.
- **Why a full vendor:** the run-resume loop that needed changing lives deep in
  `child/run-child.ts` (`runWorkflowChild` → `establishChild`, ~1,250 LOC of
  tightly-coupled internal plumbing). A thin re-export could not inject into it,
  and re-vendoring only that file would have pulled most of the package anyway.
- **WORKBENCH-LOCAL change (CL-2535):** a `recoverParkedRun` hook on
  `runWorkflowChild` / `runWorkflowChildFromProcessEnv`. A run discovered with an
  unresumable tail (`awaiting-signal` / `awaiting-timer` / `in-flight`) is offered
  to the host, which returns a host-satisfied seed log (gate completed from the
  durable signal) to resume it, or `null` to fall through to the default path.
  The runtime (`@intx/workflow`) is **not** changed — resume is the host's job by
  the runtime's own design. See the project "Resumable workflow runs (survive
  redeploys)".
- **WORKBENCH-LOCAL change (CL-2537):** a LIVE SIGNAL WATCHER on `runWorkflowChild`,
  all in `child/run-child.ts` (marked `// WORKBENCH-LOCAL (CL-2537)`). The
  self-discovery loop is restructured into a classifier: a run parked at an
  `awaitSignal` gate STILL waiting (the host hook cleanly returned `null` — no
  signal delivered yet) now installs a fire-and-forget, process-scoped watcher
  instead of letting `runtimeRun` reject the unresumable tail. The watcher builds
  a per-run `createWorkflowHostSignalChannel`, subscribes-then-rechecks (closing
  the deliver-before-subscribe race, since `subscribeKind` tails from `head`), and
  on signal arrival re-reads the log, calls the same `recoverParkedRun` hook to
  satisfy the gate, and resumes via `runtimeRun` with the same terminal-event
  continuation as the resume/trigger paths — saving the parked HITL run across a
  sidecar restart and letting it reach terminal so the supervisor's serial
  dispatch loop unwedges. A `parkedWatchers` set is aborted+awaited in the
  run-loop `finally` so no `subscribeKind` iterator leaks. The watcher's
  `recoverFromCurrentLog` read is wrapped in `readRunLogTolerant` (bounded ENOENT
  retry) because the raw working-tree read can race a concurrent commit's
  checkout. Process-scoped on purpose: single-live-child is the safety guarantee
  against double-drive, so it is NOT hoisted to the supervisor (recycle awaits
  `handle.exited` before respawn; redeploy mints a fresh deploymentId →
  disjoint workflow-run repo). The runtime is **not** changed.
- **WORKBENCH-LOCAL change (CL-2585):** the control channel moved off the
  child's stdin/stdout onto dedicated inherited fds, in
  `child/from-process-env.ts` (marked `// WORKBENCH-LOCAL (CL-2585)`). Upstream's
  `defaultControlReader`/`defaultControlWriter` read/write `process.stdin` /
  `process.stdout`; ours read `CONTROL_DOWN_FD = 4` and write `CONTROL_UP_FD = 5`
  (the control channel is bidirectional, so it needs two pipes — a single Bun
  `"pipe"` slot is unidirectional). This frees stdin/stdout/stderr for the
  child's normal logs: `@intx/log` routes INFO/DEBUG to stdout, which used to
  interleave into the NDJSON control stream and crash the supervisor's control
  reader (`control channel received non-JSON line`) → `onChildCrash` → run
  died with `reason=corrupt`. The fd constants are exported and must stay in
  lockstep with the supervisor's `Bun.spawn` `stdio` indices in
  `apps/sidecar/src/workflow-host-wiring.ts` (a duck-typed seam — see AGENTS.md).
  This supersedes the interim console→stderr redirect that was carried in
  `bin/workflow-child` (now removed).
- **WORKBENCH-LOCAL change (CL-2651):** interpolation fix in
  `supervisor/supervisor.ts` — upstream logs a literal `{reason}` (missing the
  `$`) in both the control-channel and event-channel `onCrash` logs, so the
  crash cause never prints. Both sites are fixed and marked
  `// WORKBENCH-LOCAL (CL-2651)`. Still unfixed upstream at pin `13fb9ac`;
  drop these blocks only when upstream interpolates the reason itself.
- **Lint:** the package is `eslint`-exempt (`eslint.config.ts` `globalIgnores`,
  same as `interchange/**`) — it is vendored upstream code with its own
  disable-directive conventions.
- **⚠️ Hub ↔ sidecar on-disk format parity (re-sync invariant):** `apps/hub`
  still imports the workflow-run **repo-store / blob-substrate adapters from the
  UPSTREAM `@intx/workflow-host`** (`apps/hub/src/routes/workflow-runs.ts`,
  `projection-bridge.ts`), and the hub **reads the same workflow-run repos the
  sidecar's vendored adapters write**. They are byte-identical today. So a
  pin-bump re-sync must keep `packages/workflow-host/src/adapters/{repo-store,blob-substrate}.ts`
  **on-disk-format-compatible with the upstream the hub consumes**, not merely
  IPC-compatible with the vendored child. A silent divergence there corrupts hub
  run reads with a green build — re-check these two adapters byte-for-byte on
  every bump.

### `packages/storage-isogit` → `@workbench/storage-isogit`

- **Vendors:** `@intx/storage-isogit` — a copy of
  `interchange/packages/storage-isogit` (re-synced at pin `13fb9ac`, bringing
  in `gc.ts`, `repo-disk.ts`, `repo-lock.ts` and the write-path reclaim). No
  longer fully verbatim: `store.ts` carries the **WORKBENCH-LOCAL (CL-2663)**
  read-serialization divergence below; everything else is byte-identical to
  upstream.
- **Imported by:** `apps/hub` and `apps/sidecar` agent-repo/context stores
  (`createIsogitStore`, `createAgentRepoStore` paths) — both sides of the
  pack-exchange wire.
- **Re-sync rule:** re-copy from upstream on every pin bump, then re-apply the
  CL-2663 block in `store.ts` (everything else stays a clean copy).
  **On-disk-format parity invariant:** the hub reads packs and repos the sidecar
  writes (and vice versa); `store.ts` / `pack-receive.ts` / `pack-send.ts` must
  stay format-identical to the upstream the other consumers compile against. A
  silent format divergence corrupts agent-repo reads with a green build — the
  same failure class as the workflow-host repo-store adapters above.
- **`receivePackObjects` lock asymmetry (CL-2663):** unlike `applyPack`, which
  acquires the repo-dir lock itself, `receivePackObjects` does NOT self-lock —
  callers must already hold the per-directory lock (`withRepoDirLock`) around
  it. It currently has no production caller in this repo; if one is added,
  wrap the call in the lock. Documented here rather than diverging from the
  verbatim vendor.
- **Read-vs-GC race — WORKBENCH-LOCAL (CL-2663) divergence in `store.ts`:**
  upstream runs store reads (`readAt`, `log`, `readManifestHistory` — any
  git-object walk) without the repo-dir lock while `maybeGCUnderLock` on the
  write path publishes a consolidated pack and deletes the superseded ones; a
  read that enumerated the old pack then fails on a still-reachable object
  (isomorphic-git `InternalError: Could not read packfile ...
pack-recv-gc-*.pack`, plus bare `TypeError`s from torn `.idx` loads).
  The CL-2663 block wraps those three read methods in `withRepoDirLock`, so
  reads and GC serialize per repo dir. A bounded retry on the narrow pack-miss
  error was tried first and rejected: the torn-`.idx` failure shapes are
  unmatchable bare `TypeError`s deep in iso-git, so a narrow retry still
  loses. Tradeoff: git-object reads queue behind writers/GC on the same dir;
  working-tree reads (`load`, `readBlob`) stay unlocked. Local-only because
  we never modify `interchange/`; **drop condition:** upstream
  `@intx/storage-isogit` coordinating reads with GC (locking, retrying, or
  epoch-pinning pack access) — then re-copy verbatim. Permanent regression
  guard: `src/gc-read-race.test.ts` (WORKBENCH-LOCAL (CL-2663) test file;
  reproduced the failure 5/5 before the fix). On every pin bump, re-apply the
  CL-2663 block on top of upstream `store.ts` — a literal re-copy compiles
  green and silently re-introduces the race.

### `packages/hub-agent` → `@workbench/hub-agent` (fork, NOT a verbatim vendor)

- **Status:** genuine long-lived fork of `@intx/hub-agent`, predating the vendor
  discipline. It carries real workbench features upstream lacks (reconnect
  backoff/jitter and the outbound queue from the CL-2405 sidecar-disconnect work,
  `sanitizeAddress`/agent-paths exports) but its divergences are **untagged** —
  the WORKBENCH-LOCAL audit and the drift script are blind to it.
- **Known upstream fixes not yet adopted** (found in the 13fb9ac bump review,
  tracked in CL-2662): upstream's `repoOpQueues`/`drainRepoOps` model (serializes
  all per-agent repo ops and drains before `deleteAgentDir`; ours serializes only
  mail commits) and the empty-address `register` frame on socket open (provisions
  route during session restore).
- **Re-sync rule:** do NOT literally re-copy from upstream — that would drop the
  reconnect machinery. Diff deliberately, adopt upstream fixes piecewise, and tag
  any newly-audited divergence with a WORKBENCH-LOCAL token as it is touched.

---

## Vendored sidecar files

Copied from interchange's reference `apps/sidecar/src/*` and `bin/workflow-child`.
Each row is a WORKBENCH-LOCAL divergence kept on top of the upstream copy.

| Added      | CL      | Where                                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-19 | CL-2199 | `workflow-host-wiring.ts`                                | `TENANT_ID` + `WORKFLOW_RAW_DEPLOYMENT_ID` in the multi-step `substrateEnv`; the workflow-child's `filterSubstrateConfig` requires both and throws without them.                                                                                                                                                                                                                                                       |
| 2026-06-21 | CL-2231 | `workflow-host-wiring.ts`                                | `ownedDirs` capture + undeploy-hook reclaim sweep (deletes per-deployment git repos/step dirs) to stop the sidecar-volume inode leak.                                                                                                                                                                                                                                                                                  |
| 2026-06-24 | CL-2340 | `workflow-run-pack-client.ts`, `workflow-host-wiring.ts` | Delta-cursor + size-ceiling pack push (`buildDeltaPack`, ack-gated `lastAckedTip`, `WorkflowRunPackTooLargeError`) + undeploy drain barriers, to stop the shared sidecar OOM-ing on a wedged run.                                                                                                                                                                                                                      |
| 2026-06-25 | CL-2363 | `workflow-host-wiring.ts`                                | `assertSubstrateEnvComplete(substrateEnv)` guard — fails the deploy loudly if any required substrate key is missing instead of letting the child throw deep in a spawn.                                                                                                                                                                                                                                                |
| 2026-06-25 | CL-2400 | `workflow-host-wiring.ts`                                | Register-deployment-before-spawn ordering + reconnect re-register, fixing "no agent address registered for deployment".                                                                                                                                                                                                                                                                                                |
| 2026-06-25 | CL-2401 | `workflow-host-wiring.ts`                                | Non-fatal deterministic source steps (degrade to a recorded skip rather than failing the run).                                                                                                                                                                                                                                                                                                                         |
| 2026-06-26 | CL-2503 | `bin/workflow-child`                                     | `setupObservability` + Sentry flush-on-teardown so workflow-step failures (the process where steps actually run) reach Sentry.                                                                                                                                                                                                                                                                                         |
| 2026-06-27 | CL-2535 | `bin/workflow-child`                                     | Pass the `recoverParkedRun` hook (uses `recoverParkedRunFromLog` from `src/workflow-resume.ts`) into `@workbench/workflow-host`.                                                                                                                                                                                                                                                                                       |
| 2026-06-30 | CL-2585 | `workflow-host-wiring.ts`                                | `defaultSubprocessSpawner` spawns with `stdio: ["inherit","inherit","inherit","pipe","pipe","pipe"]` and wires the control channel off dedicated fds 4 (down) / 5 (up) instead of child stdin/stdout, so child logs reach container stdout/stderr at correct severity (pairs with the `from-process-env.ts` package change). Removed the interim `console.{log,info,debug}→stderr` redirect from `bin/workflow-child`. |

The non-vendored helper that backs the CL-2535 hook lives at
`apps/sidecar/src/workflow-resume.ts` (`hostSatisfyAwaitSignal`,
`recoverParkedRunFromLog`) — it is our own code, not a vendored file.

## Supersession audit — pin `13fb9ac` (CL-2651, 2026-07-01)

Upstream baseline is now interchange `13fb9ac`. Every WORKBENCH-LOCAL block was
adjudicated against the `2c43b57..13fb9ac` range; none was superseded:

- **CL-2400 vs upstream `14e8dff`** ("Register the sidecar for routing before
  restoring sessions"): different layer. Upstream fixes the hub's sidecar
  routing map (empty-address `register` frame on WS socket-open, so provisions
  route during session restore). Ours orders the sidecar-local
  `DeploymentAddressRegistry` `Map.set` before `supervisor.spawn`/`deploy` so
  workflow-run pack pushes never throw "no agent address registered". Kept.
- **CL-2231 vs upstream agent-repo GC (`f0c95b3`, `67e7b0f`, `080241d`,
  `88a24a5`)**: complementary. Upstream reclaims objects INSIDE live agent
  repos (iso-git GC on the write path) and drains agent-repo operation chains
  before deleting an AGENT directory. Ours removes ORPHANED per-deployment
  workflow-run/step-state repo DIRECTORIES on workflow undeploy. No sub-piece
  overlaps; kept in full.
- **CL-2340 drain barriers vs upstream `88a24a5`/`5e2c202`**: different layer.
  Upstream drains agent-repo reads/pack-applies in `hub-agent`'s session
  manager; ours drains workflow-run PACK PUSHES in the sidecar undeploy hook
  so a late ack cannot resurrect a stale delta cursor. Kept.
- **Sealed event log (upstream `c7cbd58`/`ca253d4`)**: terminated runs are now
  compacted to one `events.jsonl`. All local read paths (CL-2535 recovery,
  CL-2537 watcher, self-discovery) route through the layout-aware
  `readAllEventsForRun` in the vendored `adapters/repo-store.ts` (re-synced
  from upstream); sealing is terminal-only, so parked runs are never sealed;
  the CL-2231 sweep removes whole directories and is layout-agnostic. No fix
  needed.
- **CL-2651 `{reason}` interpolation**: still broken upstream at `13fb9ac`
  (both crash-log sites); re-applied and kept.

## On every interchange pin bump

1. `git grep "WORKBENCH-LOCAL (CL-"` before and after — no block may disappear.
2. Diff each vendored file (and `packages/workflow-host/src/**`) against the new
   upstream and re-apply upstream changes **while preserving every
   `WORKBENCH-LOCAL` block**.
3. Re-run `bun run --filter @workbench/sidecar test` and
   `bun run --filter @workbench/workflow-host typecheck`.
4. `scripts/check-vendored-drift.sh <prior-ref>` surfaces dropped WORKBENCH-LOCAL
   lines for review.
