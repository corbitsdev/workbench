# Vendored Interchange Code

This repo vendors (copies) some Interchange (`faremeter/interchange`, `@intx/*`)
code into our tree so we can change behavior the upstream packages don't expose a
seam for — without editing the `interchange/` submodule. Every divergence from the
upstream original is tagged with a `// WORKBENCH-LOCAL (CL-XXXX)` comment.

**Audit handle:** `git grep "WORKBENCH-LOCAL (CL-" -- apps/sidecar packages/workflow-host`
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

---

## Vendored sidecar files

Copied from interchange's reference `apps/sidecar/src/*` and `bin/workflow-child`.
Each row is a WORKBENCH-LOCAL divergence kept on top of the upstream copy.

| Added      | CL      | Where                                                    | What                                                                                                                                                                                              |
| ---------- | ------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-19 | CL-2199 | `workflow-host-wiring.ts`                                | `TENANT_ID` + `WORKFLOW_RAW_DEPLOYMENT_ID` in the multi-step `substrateEnv`; the workflow-child's `filterSubstrateConfig` requires both and throws without them.                                  |
| 2026-06-21 | CL-2231 | `workflow-host-wiring.ts`                                | `ownedDirs` capture + undeploy-hook reclaim sweep (deletes per-deployment git repos/step dirs) to stop the sidecar-volume inode leak.                                                             |
| 2026-06-24 | CL-2340 | `workflow-run-pack-client.ts`, `workflow-host-wiring.ts` | Delta-cursor + size-ceiling pack push (`buildDeltaPack`, ack-gated `lastAckedTip`, `WorkflowRunPackTooLargeError`) + undeploy drain barriers, to stop the shared sidecar OOM-ing on a wedged run. |
| 2026-06-25 | CL-2363 | `workflow-host-wiring.ts`                                | `assertSubstrateEnvComplete(substrateEnv)` guard — fails the deploy loudly if any required substrate key is missing instead of letting the child throw deep in a spawn.                           |
| 2026-06-25 | CL-2400 | `workflow-host-wiring.ts`                                | Register-deployment-before-spawn ordering + reconnect re-register, fixing "no agent address registered for deployment".                                                                           |
| 2026-06-25 | CL-2401 | `workflow-host-wiring.ts`                                | Non-fatal deterministic source steps (degrade to a recorded skip rather than failing the run).                                                                                                    |
| 2026-06-26 | CL-2503 | `bin/workflow-child`                                     | `setupObservability` + Sentry flush-on-teardown so workflow-step failures (the process where steps actually run) reach Sentry.                                                                    |
| 2026-06-27 | CL-2535 | `bin/workflow-child`                                     | Pass the `recoverParkedRun` hook (uses `recoverParkedRunFromLog` from `src/workflow-resume.ts`) into `@workbench/workflow-host`.                                                                  |

The non-vendored helper that backs the CL-2535 hook lives at
`apps/sidecar/src/workflow-resume.ts` (`hostSatisfyAwaitSignal`,
`recoverParkedRunFromLog`) — it is our own code, not a vendored file.

## On every interchange pin bump

1. `git grep "WORKBENCH-LOCAL (CL-"` before and after — no block may disappear.
2. Diff each vendored file (and `packages/workflow-host/src/**`) against the new
   upstream and re-apply upstream changes **while preserving every
   `WORKBENCH-LOCAL` block**.
3. Re-run `bun run --filter @workbench/sidecar test` and
   `bun run --filter @workbench/workflow-host typecheck`.
4. `scripts/check-vendored-drift.sh <prior-ref>` surfaces dropped WORKBENCH-LOCAL
   lines for review.
