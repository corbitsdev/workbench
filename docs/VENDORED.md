# Vendored Interchange Code

This repo vendors (copies) some Interchange (`faremeter/interchange`, `@intx/*`)
code into our tree so we can change behavior the upstream packages don't expose a
seam for — without editing the `interchange/` submodule. Every divergence from the
upstream original is tagged with a `// WORKBENCH-LOCAL (CL-XXXX)` comment.

**Audit handle:** `git grep "WORKBENCH-LOCAL (CL-" -- apps/sidecar packages/workflow-host packages/inference packages/storage-isogit`
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
- **RETIRED at the 6927e7e4 pin bump (2026-07-16, CL-3368): `recoverParkedRun`
  (CL-2535) and the live signal watcher (CL-2537) are GONE.** Upstream now
  natively resumes an untimed `awaitSignal` tail on its own boot/reconnect path
  (`isResumableAwaitingSignalStep` / `isResumableReceivedAwaitSignalStep` in the
  runtime's dag/run resume guard), so the host-side hook and the process-scoped
  watcher that used to fill that gap are both dead code against the new pin —
  deleted rather than re-applied. `apps/sidecar/src/workflow-resume.ts`
  (`hostSatisfyAwaitSignal`, `recoverParkedRunFromLog`) is deleted with them.
  Only a **timeout-bearing** `awaitSignal` or a `map`/`loop` container tail
  remains host-unsupported at cold resume — unchanged upstream limitation, not
  a workbench gap. `bin/workflow-child` no longer passes a `recoverParkedRun`
  option into `@workbench/workflow-host`.
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
- **WORKBENCH-LOCAL change (CL-3641):** `seams/signal-channel.ts` `deliver()`
  refuses to write when `runs/<runId>/events/` has no existing events
  (`maxSeq === -1`) instead of writing a seq-0 `SignalReceived`. Upstream
  computes `nextSeq = maxSeq + 1` unconditionally, so a signal that races a
  cold start (the reconciler auto-delivers before the workflow-child commits
  its seq-1 `RunStarted`) lands at seq 0; the state machine rejects seq < 1,
  permanently poisoning the run log (every fold fails forever). The refusal
  throws instead; the caller (`child/run-child.ts`'s `signal.deliver` IPC
  handler) already catches and logs the rejection without crashing, and the
  hub's durable pending-signal rail re-delivers later, so the failed delivery
  self-heals once `RunStarted` lands.
- **WORKBENCH-LOCAL change (CL-3880):** `child/serialized-tool-factories.ts`
  (new file, no upstream counterpart) + a load-time call and export in
  `child/run-child.ts` (both marked `// WORKBENCH-LOCAL (CL-3880)`).
  Upstream serializes workflow definitions raw at both write points
  (`sendMultiStepDeployFrame` puts `steps` on the deploy frame verbatim;
  `writeWorkflowRepoTree` `JSON.stringify`s the whole workflow), and
  `JSON.stringify` turns the function-valued `toolFactories` array
  elements into `null`. The materialized `workflow.json` then crashes
  `hashDefinition` → `projectAgent` (`factory.id` on null) at the first
  `RunStarted` — every triggered run dies before any tool loading.
  `apps/sidecar/src/step-agent-tools.ts` upstream documents a wire
  projection that "strips closures" to `{ id, requires }`; no such
  projection exists at pin `6927e7e4`. The sanitize rewrites unusable
  entries to inert `{ id, requires }` stubs on load and passes proper
  serialized entries through untouched, so the definition hash stays
  stable once upstream implements the projection. Drop this block when
  upstream serializes `toolFactories` properly (or hashes null-tolerantly);
  guarded by `child/serialized-tool-factories.test.ts`.
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

### `packages/inference` → `@workbench/inference`

- **Added:** 2026-07-15 (CL-3766)
- **Vendors:** `@intx/inference` (copy of `interchange/packages/inference`).
- **Imported by:** `packages/agents` (director inference path) and any workspace
  member that resolves `@intx/inference` via the root `package.json` override.
- **Why vendored:** Myra Creative / Thinking dials need provider-specific request
  bodies (`reasoning_effort`, Kimi `thinking` + `reasoning_content`, Opus 4.8
  thinking `effort`, temperature omission rules) before upstream exposes them.
- **WORKBENCH-LOCAL change (CL-3766):** `src/providers/openai.ts` merges
  `providerOptions` into chat-completions bodies and applies Kimi thinking rules;
  `src/providers/anthropic.ts` applies Opus 4.8 thinking `effort` and omits
  temperature when thinking is on for that model.
- **WORKBENCH-LOCAL change (CL-3853):** tool-call argument recovery.
  New module `src/tool-args.ts`; `src/harness.ts` finalize block parses
  completed argument buffers through `parseCompletedToolArgs` (unwraps
  model-emitted `{_raw: "<stringified args>"}` envelopes, double-encoded
  strings, and duplicated concatenated delta objects) instead of falling back
  to `{_raw: buffer}`; `src/providers/openai.ts`, `src/providers/anthropic.ts`,
  and `src/providers/google-genai.ts` serialize stored tool-call arguments
  through `sanitizeToolArgsForHistory` so a `{_raw}` envelope never
  round-trips to the model (the model imitates the shape and loops the same
  approval forever — kimi-k2.6 via OpenRouter). Guarded by
  `src/tool-args.test.ts`, the "\_raw recovery" and "history serialization"
  describes in `src/harness.test.ts`. On re-sync, preserve the `tool-args`
  import in all four files; a literal upstream copy re-introduces the
  approval loop with a green build.
- **Audit:** `rg 'WORKBENCH-LOCAL' packages/inference/` (the CL-3853 blocks
  are tagged `WORKBENCH-LOCAL` without an issue number, per repo owner
  preference — the plain-token grep still finds them)

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

- **Pin-bump seam — pack-reject reason string:** `hub-link.ts`'s workflow-run
  pack bootstrap retry classifies a permanent rejection by substring-matching
  `"path_violation"` in the error thrown by `@intx/pack-transport`'s sender
  (`pack rejected by receiver (... reason=path_violation)`), because the wire
  reason is not exposed as a typed field on the thrown error. Verified stable
  at the current pin (the hub's `receiveWorkflowRunPack` only ever emits
  `path_violation` or `corrupt`). On every interchange pin bump, re-verify the
  sender's message format and the hub's reason space still match this
  substring — drift silently re-enables the infinite identical-resend retry
  loop this classification exists to prevent.

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
- **WORKBENCH-LOCAL change (CL-3826):** per-attempt connect timeout in
  `ws/hub-link.ts`. `connect()` arms a link-scoped timer (injectable
  `scheduleConnectTimeout`, default 5s via `connectTimeoutMs` /
  `DEFAULT_CONNECT_TIMEOUT_MS`) when the socket is created; if `open` has not
  fired at expiry it closes that attempt's socket (readyState-guarded so a
  live or superseded socket is never touched) and the normal close handler
  schedules the backoff reconnect. Motivation: during a Railway hub redeploy,
  stale internal DNS can blackhole a TCP connect for the whole 120s overlap
  window — one unbounded attempt stalled reconnection ~123s. Plumbed as
  `SIDECAR_CONNECT_TIMEOUT_MS` through `sidecar-orchestrator.ts` and
  `apps/sidecar/src/config.ts`. Verified against real Bun: `ws.close()` on a
  CONNECTING socket aborts the pending connect immediately (close 1006).
  Blocks tagged `// WORKBENCH-LOCAL (CL-3826)`.
- **RETIRED at the 6927e7e4 pin bump (2026-07-16, CL-3368): the in-process
  harness runtime is gone, and CL-3102 (lazy agent restore) / CL-3103 (idle
  agent eviction) are retired with it, not re-applied.** Upstream deleted
  `launchSession` — there is no per-instance in-process harness left to lazily
  restore or idle-evict. Single-agent instances (Myra/Oat/triage/gate agents)
  now deploy as single-step `deployWorkflowDefinition` workflow deployments
  (see `apps/hub/src/services/agent-provisioning.ts`); wake-on-mail and
  idle-evict semantics re-home onto that deployment's own lifecycle (a warm
  single-step deployment plus the CL-3104 hibernate teardown below), not onto
  `session-manager.ts`. `session-manager.ts` itself is reduced to upstream's
  thin serialization layer. **Deployment-record restore was itself retired at
  CL-3884** (2026-07-18) — see the note below the vendored-files table.
- **RETIRED at the 6927e7e4 pin bump (2026-07-16, CL-3368): CL-3415
  (bootstrap-retry quarantine) and CL-3796 (retry-storm containment) are
  gone, not re-applied.** Both were mitigations against a corrupt-pack retry
  storm on the old session-per-instance `pushWorkflowRunPack` path; that path
  no longer exists (`session.abort` and the live-grants push it protected were
  retired in the same pin bump — see `c2970d0b`), and upstream's own
  reconnect public-key challenge + additive register + in-flight
  duplicate-deploy rejection covers the reconnect-storm case structurally.
  `WorkflowRunPackQuarantinedError` and the `isHubSignaledRejection`
  discriminator are deleted. CL-3409 (sleeping-agent sync log batching) is
  retired for the same reason — the "sleeping agent" concept it batched log
  lines for belongs to the deleted in-process runtime.
- **WORKBENCH-LOCAL (CL-3104) — hibernate undeploy flavor** (`src/ws/hub-link.ts`):
  `DeployRouter.hibernate`, the exported `WORKFLOW_HIBERNATE_UNDEPLOY_REASON`
  protocol constant, and the reason-scoped `handleAgentHibernate` branch in
  `handleAgentUndeploy`. An `agent.undeploy` frame carrying the hibernate reason
  tears down runtime residency (bootstrap-flag prune, session stop, router
  `hibernate` hook) but skips the state-pack push, `deleteAgentDir`, and
  `forgetAgent`, then acks so the hub drops the address from its routable set.
  On hook failure the teardown is retried once (it is idempotent); if it still
  fails the ack is withheld — NOT to keep the address routable (interchange's
  `sendAgentUndeploy` timeout arm removes the address BEFORE rejecting, so the
  hub unroutes either way) but to surface the failure loudly at the hub caller
  instead of a silent fake success. The resident-child orphan this can leave is
  self-healed by the wiring's deploy-branch resident-supervisor guard (below)
  when the wake re-deploy arrives. The reason constant has a byte-identical
  copy in `apps/hub/src/services/workflow-reconciler.ts` (the hub does not
  depend on this package); a guard test in
  `apps/hub/src/services/workflow-reconciler.test.ts` pins the two literals
  byte-identical. Guarded by `src/ws/hub-link-hibernate.test.ts`.
- **WORKBENCH-LOCAL (CL-3340) — assistant output loop guard**
  (`src/assistant-loop-guard.ts`, wired in `src/session-manager.ts`): the
  per-session `onEvent` wrapper checks each `inference.done` for the same
  cycle fingerprint three times in a row — normalized (trimmed,
  whitespace-collapsed) assistant text PLUS tool-call identity (name +
  stable-serialized arguments, call id excluded), because the practical trip
  path is tool-executing cycles within one message run and identical
  narration with different tool calls is progress, not a loop. The tripping
  duplicate is swallowed; a synthetic failed
  `message.run.ended` (`error.kind: "assistant_loop_interrupted"`) settles
  the turn hub-side with an explanation, remaining events from the aborting
  reactor are dropped, and the session is evicted through the CL-3103
  teardown back to `wakeable` — the reactor exposes no per-cycle
  cancellation, so eviction is the stop lever and the next user message
  rebuilds the session with full history. Any inbound user message
  (`deliverLive`/`deliverMessage`) or a different output resets the run;
  session go-live clears the interrupted flag. Guarded by
  `src/assistant-loop-guard.test.ts` and
  `src/session-manager-assistant-loop.test.ts`.
  **Status after the 6927e7e4 pin bump (2026-07-16):** `assistant-loop-guard.ts`
  itself was preserved verbatim, but its wiring point — the `session-manager.ts`
  per-session `onEvent` wrapper — was gone with the in-process harness runtime
  it wrapped, leaving the guard unwired.

  **Re-homed onto the sidecar's inference-event path (2026-07-17):** the
  guard's pure logic (`assistant-loop-guard.ts`, its exports, its unit tests)
  is untouched and re-exported from `packages/hub-agent`'s index. The new
  consumer is `apps/sidecar/src/assistant-loop-guard-wiring.ts`
  (`observeInferenceEventForAssistantLoopGuard`), wired into
  `workflow-host-wiring.ts`'s `onInferenceEvent` (the T3 seam below) — scoped
  to `warmKeep` single-step deployments, keyed per call by the deployment's
  agent address so concurrent agents never share run state. The stop lever
  changed with the runtime: instead of session eviction, a trip publishes a
  synthetic `inference.error{category: "aborted", message:
assistantLoopInterruptMessage(...)}` through the same
  `publishWorkflowInferenceEvent` path real inference errors use (which
  `@workbench/event-collector`'s existing `inference.error` handling already
  turns into a visible, eagerly-persisted turn part — no new user-facing
  surface needed) and calls `supervisor.drain({ deadlineMs: 0 })`, which
  escalates the drainTimeout accumulator to a signed
  `CancelRequested{origin: "supervisor-drain"}` immediately, tearing the
  looping run down through the runtime's existing cancellation cascade. The
  guard resets on every inbound mail message (the mail-router registration in
  `workflow-host-wiring.ts`, also `// WORKBENCH-LOCAL (CL-3340)`) and on
  undeploy. Guarded by `assistant-loop-guard-wiring.test.ts` (pure wiring
  unit tests) and new cases in `workflow-host-wiring.test.ts`'s "assistant
  loop guard wiring" describe block (end-to-end through the real HMAC event
  channel and control channel).

- **WORKBENCH-LOCAL (CL-3779) — inline heartbeat handling** (`src/ws/hub-link.ts`):
  every inbound WS frame — including the heartbeat `pong` — was chained onto a
  single serial `messageQueue` promise, on which heavy sibling arms are
  `await`ed (notably `repo.pack.done` → `await handlePackDone(...)`, an
  isomorphic-git pack-apply disk write). A pack-apply that held the queue
  longer than the pong window (`pingIntervalMs * 2`) starved the queued `pong`,
  `lastPongAt` went stale, and the ping timer (CL-2405) closed the sidecar's own
  healthy socket ("Hub pong timeout, closing connection") — the same
  self-disconnect class as the CL-2405 heartbeat work. The `ws.message`
  listener now guardedly parses the frame and, if its type is `"pong"`, sets
  `lastPongAt` synchronously and returns BEFORE enqueuing, so the heartbeat can
  never be blocked by awaited sibling I/O. A length gate (`data.length < 64`)
  keeps the inline `JSON.parse` off the hot/large frames (e.g. `repo.pack.push`
  chunks), so only tiny heartbeat-sized frames are re-parsed. All other frames
  enqueue exactly as before. The `case "pong"` arm in `handleMessage` is
  retained — a real `pong` is valid JSON and always takes the inline path, so
  that arm is unreachable for inline-handled pongs; it is kept for parity with
  upstream `@intx/hub-agent` (minimizing fork drift), not as a live path. No
  inbound `ping` arm exists in `handleMessage`, so none was added — the sidecar
  pings the hub, not vice versa. The deeper head-of-line blocking (a heavy
  awaited `handlePackDone` pack-apply stalls ALL inbound frames on the serial
  queue, not just pong) is tracked in CL-3781 and deferred. Guarded by
  `src/ws/hub-link-heartbeat.test.ts`.

---

## Vendored sidecar files

Copied from interchange's reference `apps/sidecar/src/*` and `bin/workflow-child`.
Each row is a WORKBENCH-LOCAL divergence kept on top of the upstream copy.

| Added      | CL      | Where                                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-19 | CL-2199 | `workflow-host-wiring.ts`                                | `TENANT_ID` + `WORKFLOW_RAW_DEPLOYMENT_ID` in the multi-step `substrateEnv`; the workflow-child's `filterSubstrateConfig` requires both and throws without them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-06-21 | CL-2231 | `workflow-host-wiring.ts`                                | `ownedDirs` capture + undeploy-hook reclaim sweep (deletes per-deployment git repos/step dirs) to stop the sidecar-volume inode leak.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-06-24 | CL-2340 | `workflow-run-pack-client.ts`, `workflow-host-wiring.ts` | Delta-cursor + size-ceiling pack push (`buildDeltaPack`, ack-gated `lastAckedTip`, `WorkflowRunPackTooLargeError`) + undeploy drain barriers, to stop the shared sidecar OOM-ing on a wedged run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-06-25 | CL-2363 | `workflow-host-wiring.ts`                                | `assertSubstrateEnvComplete(substrateEnv)` guard — fails the deploy loudly if any required substrate key is missing instead of letting the child throw deep in a spawn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-06-25 | CL-2401 | `workflow-host-wiring.ts`                                | Non-fatal deterministic source steps (degrade to a recorded skip rather than failing the run).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-06-26 | CL-2503 | `bin/workflow-child`                                     | `setupObservability` + Sentry flush-on-teardown so workflow-step failures (the process where steps actually run) reach Sentry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-06-30 | CL-2585 | `workflow-host-wiring.ts`                                | `defaultSubprocessSpawner` spawns with `stdio: ["inherit","inherit","inherit","pipe","pipe","pipe"]` and wires the control channel off dedicated fds 4 (down) / 5 (up) instead of child stdin/stdout, so child logs reach container stdout/stderr at correct severity (pairs with the `from-process-env.ts` package change). Removed the interim `console.{log,info,debug}→stderr` redirect from `bin/workflow-child`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-07-04 | CL-2783 | `workflow-host-wiring.ts`                                | `writeStepGrants` per-step grant writes parallelized with a bounded worker pool (`STEP_GRANTS_WRITE_CONCURRENCY = 12`) instead of a serial `for ... await` loop. Each step writes a DISTINCT `<deploymentId>-<stepId>` repo and `@workbench/storage-isogit` locks per-DIRECTORY (`withRepoDirLock`), so concurrent different-repo writes never contend; the serial loop stacked each step's isogit commit+fsync wait (~254ms/step measured) onto the cold workflow-spawn critical path. The pool preserves the serial loop's fail-at-deploy contract (the first write failure rejects the call; the caller's `finally` unwinds partial state) AND drains: each worker records the first error and stops taking new steps but awaits its in-flight write, and the call awaits EVERY worker before re-throwing — so no sibling write is still mid-commit when the rejection reaches teardown (a bare `Promise.all` would reject while stragglers still commit, letting a retried deploy at the same address race a straggler's commit into a step repo). Guarded by `apps/sidecar/src/workflow-host-wiring-write-step-grants.test.ts`. The supervisor's `assembleCredentialsSnapshot` per-step READ loop (`packages/workflow-host/src/supervisor/credentials.ts`) was audited and deliberately NOT changed — `readStepGrants` is a plain working-tree `fs.readFile` + JSON.parse + sha256, not an isogit commit/fsync, so it is cheap and unlocked; parallelizing it buys nothing. |
| 2026-07-09 | CL-3104 | `workflow-host-wiring.ts`                                | Resident-supervisor self-heal in `deployMultiStep`: if `activeSupervisors` already holds the address (a hibernate whose ack path failed left the child resident while the hub unrouted it), the deploy branch runs `teardownDeployment(address, { reclaimDirs: false })` before standing the fresh supervisor up — otherwise the old child leaks and two children drive one workflow-run repo. Guarded by `workflow-host-wiring-hibernate.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-07-08 | CL-3104 | `workflow-host-wiring.ts`                                | Hibernate flavor of the deploy-router teardown: the undeploy hook body moved into a shared `teardownDeployment(agentAddress, { reclaimDirs })`, and a new `hibernate` router method calls it with `reclaimDirs: false` — same residency teardown (routers, supervisor/child kill, CL-2340 drain barrier, slug, deployment mapping) but the CL-2231 owned-dirs rm and the `workflow-step-state/<deploymentId>` scratch rm are gated OFF, so a gate-parked run's durable state survives for the signal-driven resume. On a pin-bump re-sync, re-apply upstream undeploy changes INSIDE `teardownDeployment`, preserving both `reclaimDirs` gates. Guarded by `workflow-host-wiring-hibernate.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2026-07-11 | CL-3379 | `workflow-substrate-factory.ts`                          | The `INLINE_INFERENCE_KIND` dispatch branch in `createSidecarStepInvoker` now threads this invocation's `onEvent` sink into `runInlineInferenceStep` (previously omitted, so inline single-turn steps — the heartbeat brief's per-member inference — silently discarded their whole event stream and never reached `analytics_event`). The sink is the same per-step `onEvent` the inference branch (`createWorkflowStepInvoker`) receives, which chains up through `buildStepInvoker` → the child `invokeStep` binding → `workflow-host-wiring.ts`'s `onInferenceEvent`/`publishInferenceEvent`, carrying the deployment's `agentAddress`/`sessionId` attribution — no new identity was fabricated. The actual forwarding loop lives in `apps/sidecar/src/inline-inference-step.ts` (WORKBENCH-OWNED, no upstream counterpart, so it carries no vendored-file audit burden): its stream-drain loop now forwards every non-`message.received` event to the sink instead of discarding it, swallowing a throwing sink so a downstream consumer's failure can never fail the step. Guarded by `apps/sidecar/src/inline-inference-step.test.ts`.                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-13 | CL-3468 | `child/run-child.ts`                                     | `resolveTriggerPayload` decodes hub run-start mail (`from: hub@…`, body `JSON.stringify(input)`) into a JSON object for `trigger.payload`; all other senders keep plain conversation text. Guarded by `packages/workflow-host/src/child/run-child.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-07-16 | CL-3368 | `workflow-deployment-record.ts`, `atomic-write.ts`       | NEW verbatim vendors (no upstream counterpart) added at the 6927e7e4 pin bump. **`workflow-deployment-record.ts` deleted at CL-3884 (2026-07-18)** — see "Deleted vendor — CL-3884 (2026-07-18)" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Retired at the 6927e7e4 pin bump (2026-07-16, CL-3368), not carried forward:**
CL-2400 (register-deployment-before-spawn ordering — upstream's own reconnect
public-key challenge + additive register + in-flight duplicate-deploy
rejection now covers the "no agent address registered" failure mode
structurally), CL-2535 (`recoverParkedRun` pass-through in `bin/workflow-child`
— the hook itself is gone, see `packages/workflow-host` above), CL-2780
(TEMPORARY provisioning-path timing instrumentation — was already marked
removable, dropped as dead weight during the re-sync), and CL-3780 (trivial-
branch `onAgentEvent` listener disposer — the trivial-launch branch it guarded
does not exist on the new single-step-workflow launch path; the listener leak
it fixed cannot recur because there is no more `trivialLaunch`).

## Deleted vendor — CL-3884 (2026-07-18)

### `apps/sidecar/src/workflow-deployment-record.ts` — DELETED

Added at the 6927e7e4 pin bump (see history below), deleted at CL-3884 along
with every boot-time restore path in `workflow-host-wiring.ts`
(`restoreWorkflowDeployments`, the deployment-record write/scan/delete calls,
dormant markers) and the `index.ts` boot call that invoked restore. The
sidecar no longer persists anything durable beyond the workflow-run substrate
itself; a freshly-booted sidecar hosts nothing until the hub deploys to it.

Rationale: the hub is already the control plane for re-establishing every
resident deployment — mail-wake re-deploys an idle single-step agent, gate
signals plus the awaiting-prewarm re-establish a parked multi-step run, and
the run-liveness sweep fails a running run whose child died with the sidecar
process. The record-and-restore path duplicated that control-plane role
sidecar-side for no case the hub didn't already cover, at the cost of the
CL-2199 substrate-env persistence and the CL-3368 resurrection-guard tombstone
below, both of which are retired with it (there is nothing left to guard
against resurrecting once nothing is ever restored). A sources rotation
(`sources.update`) is now a process-local respawn hint only: it survives a
recycle respawn (the supervisor still holds `currentSources` in memory) but
not a full sidecar restart — the hub-driven re-deploy re-resolves sources
fresh, which is the native source of truth.

`apps/sidecar/src/workflow-deployment-dirs.ts` is the small piece of that file
kept as an owned (non-vendored) helper: `workflowDeploymentDir` (the pure path
computation) and `reclaimWorkflowDeploymentDir` (the on-disk rm used when an
undeploy has no in-memory supervisor to sweep via `ownedDirs`). Neither reads
or writes a record — they operate on the directory itself.

`apps/sidecar/src/atomic-write.ts` (the shared `writeFileAtomicDurable`
primitive `workflow-deployment-record.ts` and its tombstone built on) had no
caller left, so it is DELETED with the record layer (same cleanup).

### `apps/sidecar/src/workflow-deployment-record.ts` + `atomic-write.ts` — history (6927e7e4 pin bump, 2026-07-16)

Both were added as new verbatim-vendor files with no upstream counterpart
(workbench-only sidecar-local persistence), added alongside the 6927e7e4 pin
bump rather than carried forward from an older file. `workflow-deployment-record.ts`
persisted the per-deployment record needed to re-establish a workflow
deployment across a sidecar **process restart** (co-located with the
deployment's workflow-run substrate at
`${dataDir}/workflow-runs/<deploymentId>/deployment.json`). It carried:

- **CL-2199:** the tenant scope + raw hub deploymentId (`ses_<id>`) the
  substrate env threading needed to rebuild `SubstrateConfig` on restore — the
  same two keys `workflow-host-wiring.ts` requires at deploy time (see the
  `WorkflowDeploySpec` note below), also durable across a process restart
  rather than frame/in-memory only.
- **CL-3368 — resurrection-guard tombstone.** Upstream's boot restore
  re-spawned every on-disk deployment record unconditionally. The hub's
  undeploy/teardown call is fire-and-forget with only a boot-time 24h janitor
  behind it, so a missed teardown ack plus a sidecar-only process restart (not
  a full redeploy) could otherwise resurrect a terminated deployment forever —
  its record still on disk, no live tombstone to say it's done. An undeploy
  wrote a durable tombstone (atomic, via `writeFileAtomicDurable`) into the
  deployment's directory before the directory itself was reclaimed; boot-time
  restore checked for the tombstone and skipped re-spawning a tombstoned
  deployment, then reclaimed the now-stale directory.

Both mechanisms are retired at CL-3884 above — there is no boot-time restore
left for a durable record or a tombstone to guard.

### `apps/sidecar/src/workflow-substrate-factory.ts` — acknowledged FORK

(like `packages/hub-agent`), now converging toward the upstream on-disk model

**Update — hard cutover to on-disk tool materialization (2026-07-17).** The
hub-RPC step-tool RESOLUTION fork is retired. Every deployed agent/step now
reads its pinned tool closure from the deploy tree the hub stages on disk —
upstream's model (`readDeployTree` → `@intx/tool-packaging` loader). What was
deleted:

- `apps/hub/src/routes/tool-manifest.ts` — the `/api/internal/tools/manifest`
  rail (route + test) — and its wiring in `apps/hub/src/index.ts`.
- `apps/sidecar/src/step-tool-harness.ts` `fetchStepToolManifest` — the hub-RPC
  manifest fetch — replaced by `readStepDeployTree` reading the on-disk tree at
  `<dataDir>/<sanitizeAddress(stepAddress)>/deploy/`.
- The `ToolManifest{Request,Tarball,Response}` types in
  `@workbench/tool-credentials`.

What was ADDED / restored:

- Multi-step per-step staging: `apps/hub/src/services/workflow-deploy.ts` now
  wires the orchestrator's `launchSession` to interchange's
  `SessionService.stageWorkflowStep` (was a no-op, `noLaunchStepSession`), so
  each step's tool closure is resolved to a `deploy/tool-packages-manifest.json`
  - asset tarballs and staged on disk. Single-agent instances stage their head
    tree through interchange's `deployInstanceAtHead`, which wraps the harness as
    a single-step workflow and routes THROUGH `deploySingleStepAtHead` (one path,
    not two parallel ones) — the same single-step-at-head hand-off a one-step
    workflow definition uses.
- Sidecar `stepDeployTreeDir` (in `workflow-substrate-factory.ts`, mirroring
  interchange `apps/sidecar/src/step-agent-tools.ts`) locates the on-disk tree
  from the deployment mailbox address; `StepToolContext.deployTreeDir` carries
  it to the harness.

What was KEPT — the thin layer AROUND the native loader, NOT the resolution
fork: the tenant tool-CREDENTIAL rail (`/api/internal/tools/credentials`,
`fetchToolCredentials`), the hub-backed `RuntimeCapabilities` rail
(`/api/internal/hub-tools/run`, the `HUB_RPC` context), the per-step grants
read, `writeStepAgentRows` (feeds the credential/grants gate by `stepAgentId`),
and the `WORKFLOW_RAW_DEPLOYMENT_ID` / `deriveRawDeploymentId` threading (keys
those kept rails). The workbench keeps its own factory-invocation loop that
injects credential env + `HUB_RPC` into each loaded factory — upstream's loader
returns factories it does not invoke; the injection is the workbench's, the
resolution is now upstream's.

`workflow-substrate-factory.ts` remains an acknowledged FORK (upstream's own
restructuring — `SubstrateFactoryEnv`/`SpawnTimeEnv`, the `substrateConfig`
narrowing — must be merged **onto** the fork branch on each pin bump). Its
`WORKBENCH-LOCAL` tags (CL-2199, CL-2401, CL-2650, CL-3379) are unchanged. The
prior "follow-up: evaluate adopting on-disk materialization" is now DONE (this
change).

The non-vendored helper that used to back the CL-2535 hook,
`apps/sidecar/src/workflow-resume.ts` (`hostSatisfyAwaitSignal`,
`recoverParkedRunFromLog`), is deleted along with the hook — see "RETIRED"
above.

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

## Supersession audit — pin `6927e7e4` (runtime retirement, 2026-07-16)

Upstream deleted `launchSession` and the whole in-process single-agent
harness path this bump was gated on. Every WORKBENCH-LOCAL block from the
prior pin was re-adjudicated against that deletion, not just diffed line by
line:

- **CL-2535 / CL-2537 (`recoverParkedRun` hook + live signal watcher)**:
  superseded outright — upstream's own resume guard
  (`isResumableAwaitingSignalStep` / `isResumableReceivedAwaitSignalStep`)
  now covers the untimed-`awaitSignal` case these blocks existed for. Deleted,
  not re-applied.
- **CL-3102 / CL-3103 (lazy restore / idle eviction) and CL-3340 (loop guard)**:
  their host object, `session-manager.ts`'s in-process harness runtime, is
  gone. CL-3102/CL-3103 are retired outright (the deployment lifecycle now
  owns wake/evict semantics). CL-3340 (`assistant-loop-guard.ts`) was
  preserved as a file, unwired at bump time, and has since been re-homed onto
  the sidecar's inference-event path — see the `packages/hub-agent` section
  above.
- **CL-2400 (register-before-spawn ordering) and CL-3415/CL-3796 (pack-push
  quarantine/retry-storm containment)**: both were structural workarounds for
  reconnect races on the old session-per-instance path; upstream's rewritten
  reconnect protocol (public-key challenge + additive register + in-flight
  duplicate-deploy rejection) removes the race class they guarded against.
  Retired, not re-applied.
- **CL-2199, CL-2231, CL-2340, CL-2363, CL-2401, CL-2503, CL-2585, CL-2651,
  CL-2663, CL-2783, CL-3104, CL-3379, CL-3468, CL-3641, CL-3766, CL-3779,
  CL-3826**: all still address a live upstream gap at `6927e7e4` (verified
  per-block during the re-sync, not assumed) and were re-applied on top of
  the re-synced files.
- **New:** CL-3368 (deployment-record resurrection-guard tombstone) closed a
  gap this bump's own architecture change opened (see "Deleted vendor —
  CL-3884" above — both the record and the tombstone it needed are retired);
  `workflow-substrate-factory.ts`'s FORK reclassification is a process change,
  not a new behavioral block.

## On every interchange pin bump

1. `git grep "WORKBENCH-LOCAL (CL-"` before and after — no block may disappear.
2. Diff each vendored file (and `packages/workflow-host/src/**`) against the new
   upstream and re-apply upstream changes **while preserving every
   `WORKBENCH-LOCAL` block**.
3. Re-run `bun run --filter @workbench/sidecar test` and
   `bun run --filter @workbench/workflow-host typecheck`.
4. `scripts/check-vendored-drift.sh <prior-ref>` surfaces dropped WORKBENCH-LOCAL
   lines for review.
