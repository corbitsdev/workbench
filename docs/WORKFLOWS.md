# Workflows — execution model, divergences, and the vendored surface

This is the authoritative doc for **how a workflow actually runs** in GTM
Workbench: what happens between a user clicking "start" and a step's agent
producing output, where the workbench deliberately diverges from Interchange's
reference runtime, and why the divergence exists as vendored code.

Companion docs:

- [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md) — how a workflow is authored,
  pushed, deployed, superseded, and auto-published.
- [ARCHITECTURE.md](./ARCHITECTURE.md) § Native Workflow Runtime — the
  tech-agnostic structure and the generic run model.
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) § Workflow Deploy and Run Routes — the
  concrete routes, files, and schema.
- [VENDORED.md](./VENDORED.md) — the canonical catalogue of every vendored
  `@intx/*` change (this doc summarizes it; that doc is the source of truth).

## TL;DR — the mental model

- A **workflow** is a git-backed `@intx/workflow` definition package under
  `workflows/<kind>/`. The hub imports none of them; it deploys definitions and
  observes runs.
- A **run** is a native `WorkflowEvent` log in a git-backed `workflow-run` repo.
  Every UI surface is a fold of that log — nothing else is the source of truth.
- Each run provisions its **own ephemeral deployment**: one supervisor process +
  one `workflow-child` subprocess on the sidecar. **All steps run in-process
  inside that one child** — the workbench does **not** launch a live agent
  session per step. This is the central divergence from Interchange's reference
  runtime, and it exists for RAM and start-latency reasons.
- A step gets its tools not from a launched session's deploy pack but from a
  **hub-RPC tool rail** — it fetches its manifest + tarballs at run time, gated
  on the persisted `agent` DB row, and reads grants from `state/grants.json`.
- The runtime lives in **vendored copies** of Interchange code (a full
  `@intx/workflow-host` fork plus vendored sidecar wiring), each divergence
  tagged `// WORKBENCH-LOCAL (CL-XXXX)`. Interchange is independently converging
  toward this same launch-free model, so the fork is a lead, not a permanent
  split.

## The execution model

### From click to running step

1. **Start.** `POST /workflow-exec/:kind/start`
   (`apps/hub/src/routes/workflow-run-records.ts:228`) calls `startWorkflowRun`
   (`apps/hub/src/workflow-executor/run-exec.ts:212`). It resolves the deployed
   definition, mints a `runId`, and inserts a `provisioning` run row **before
   returning** — so the browser gets an instant ack and can show live "Starting…"
   progress while the deploy happens off the critical path (the async-start
   pattern, `run-exec.ts:205-210`).
2. **Provision a per-run deployment.** A background task
   (`provisionAndTrigger`, `run-exec.ts:247`) calls `provisionRunDeployment`
   (`apps/hub/src/services/workflow-deploy.ts:403`): it reads the published
   definition for the kind, mints a **fresh `deploymentId`**, and deploys a
   dedicated supervisor + `workflow-run` repo for this single run.
3. **Deploy.** `provisionRunDeployment` calls the deploy service's
   `deployWorkflow` (`workflow-deploy.ts:428`, defined at `:185`), which builds
   the Interchange orchestrator via `createWorkflowDeployOrchestrator`
   (`workflow-deploy.ts:337`) and runs it (`:359`). The orchestrator
   (`interchange/packages/workflow-deploy/src/orchestrator.ts:341`) commits
   `workflow.json` + `capability-declarations.json`, then hands off to the
   sidecar via `sendMultiStepDeploy` (`orchestrator.ts:512`).
4. **Spawn.** On the sidecar, `deployMultiStep`
   (`apps/sidecar/src/workflow-host-wiring.ts:1049`) constructs **one**
   supervisor (`createSidecarWorkflowSupervisor`, `:1232`) and spawns **one**
   `workflow-child` subprocess (`wired.supervisor.spawn`, `:1393`; the real
   `Bun.spawn` is at `:410`).
5. **Execute in-process.** The child (`runWorkflowChild`,
   `packages/workflow-host/src/child/run-child.ts:510`) drives the run's steps
   **inside its own process** via an in-process `invokeStep` binding
   (`run-child.ts:1329`). Each step's agent is built on demand from
   `workflow.json` + grants + the agent DB row: `buildStepAgent`
   (`packages/workflow-host/src/adapters/step-invoker.ts:337`) calls
   `createAgent(def, env)` (`:345`) with an authorize wrapper fed by the step's
   grants (`:343`). No per-step session launch, no per-step WebSocket, no
   per-step deploy pack.

### Contrast: Interchange's reference model launches a session per step

Interchange's orchestrator, run unmodified, **launches a live agent session for
every step**: `orchestrator.ts:489-500` loops over the prepared steps and
`await launchSession(...)` for each, provisioning a per-step `agent-state` repo,
before the single `sendMultiStepDeploy`. In that model a step **is** a launched
agent.

The workbench deliberately moved off this. A per-step launch is a full
deploy → pack → build → start-WebSocket cycle (~1-2s each), and holding a live
session per step was the measured **~3 GB RAM** driver on the shared sidecar (see
[the session-per-step RAM finding](#why-the-divergence)). The workbench keeps the
orchestrator API but **no-ops the launches** it does not need (below).

### Step classes and the launch no-op knob

A step declares its class with a tag, `workbench.stepKind`
(`packages/agents/src/deterministic-step.ts:13`):

| Class                               | Author helper                                        | Tag value                    | Launches a session?    |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------- | ---------------------- |
| **inline-inference**                | `inlineInferenceStep` (`deterministic-step.ts:183`)  | `inline-inference` (`:26`)   | No — no-op'd (CL-2251) |
| **deterministic-tool**              | `deterministicToolStep` (`deterministic-step.ts:96`) | `deterministic-tool` (`:15`) | No — no-op'd (CL-2252) |
| **deployed** (reasoning-with-tools) | plain `step({ agent })` with `defineAgent`           | _(no tag)_                   | No — no-op'd (CL-2782) |

**No step class launches a per-step session (CL-2782, shipped).** The hub builds a
`noLaunchAgentIds` set over **`allStepIds`** — every step's derived agent id, not
just inline + deterministic (`workflow-deploy.ts:239-243`; step classes computed
via `collectInlineStepIds` at `:1112` and `collectDeterministicToolStepIds` at
`:1131`). `toLaunchSession` (`workflow-deploy.ts:1158`) short-circuits to a
resolved no-op for any agent id in that set, so the `SessionService` is never
touched for any step — the session-per-step RAM win (CL-2251/CL-2252),
now extended to deployed reasoning steps (CL-2782). This is safe because step
execution rebuilds everything from hub-written artifacts (the agent def from
`workflow.json`, grants from `state/grants.json`, and tools via the hub-RPC rail
gated on the persisted `agent` row) — nothing the running step reads came from a
launch. The launched session was ~17s of serialized deploy → pack → session-start
round-trips per deployed step; removing it took workflow start ~17s → ~2s.

Each step executes the same way inside the child (step 5 above): the child's
`createSidecarStepInvoker`
(`apps/sidecar/src/workflow-substrate-factory.ts:888`) dispatches a
`deterministic-tool`-tagged step to `runDeterministicToolStep` (`:1020-1026` —
no reactor, no inference, tool called directly), an `inline-inference` step to a
bare `createAgent` inference (`:1035`), and every other (deployed) step to the
real tool-capable agent harness.

### The hub-RPC tool rail

A workflow step "never launches a session, so it has no deploy pack on disk." It
resolves its tools at run time over a hub RPC instead:

- The sidecar's **own** step-tool implementation
  (`apps/sidecar/src/step-tool-harness.ts`) fetches the resolved tool manifest
  and tarballs from the hub (`fetchStepToolManifest`, `step-tool-harness.ts:113`;
  the fetch to `/api/internal/tools/manifest` at `:126`), materializes the
  tarballs on disk, and resolves tool credentials via `/api/internal/tools/credentials`
  (`fetchToolCredentials`, `:271`). Steps are not session-bound, so the rail
  accepts an empty session (`:299`).
- Both hub endpoints are gated on the **persisted `agent` DB row**, not a live
  session: `/tools/manifest` (`apps/hub/src/routes/tool-manifest.ts:68`) looks
  the agent up by id (`:80-84`) and reads its `toolPackages` pins (`:87`);
  `/tools/credentials` (`apps/hub/src/routes/tool-credentials.ts:63`) applies the
  same agent-row gate. Both require the sidecar bearer token.
- Grants are read from a single canonical document, `state/grants.json`
  (`STEP_GRANTS_PATH`, `packages/workflow-host/src/supervisor/credentials.ts:45`),
  written into each deployed step's agent-state repo at deploy time by
  `writeStepGrantFiles` (`workflow-deploy.ts:1043`, called at `:271`) on the hub
  and by `writeStepGrants` (`workflow-host-wiring.ts:214`) on the sidecar.

This rail is a workbench-specific replacement. Interchange's reference
`step-agent-tools.ts` (which re-derives a step address from the deployment
mailbox and reads tools off an on-disk deploy tree) is **not run** here — the
only remaining trace of it is a dead reference in a doc comment
(`workflow-host-wiring.ts:166`).

### Runs are an event log, observed live over SSE

A run's state is a fold of its native `WorkflowEvent` log. The primary live
surface is a **run-state SSE stream** that re-folds the log server-side and emits
the authoritative `RunState` on connect and on every new event:
`GET /workflow-exec/runs/:runId/state/stream`
(`apps/hub/src/routes/workflow-run-records.ts:692`, hub route added in CL-2727).
It **replaces** a fixed-interval poll of `GET /workflow-exec/runs/:runId/state`
(`:584`) that lagged execution badly (observed ~90s stale); the web client's
stream consumer (`apps/web/src/lib/workflow-run-state-stream.ts`) landed in
CL-2779.

A raw-event SSE stream (`GET /api/v1/workflow-runs/:deploymentId/stream`,
`apps/hub/src/routes/workflow-runs.ts`) and the signal route
(`POST /api/v1/workflow-runs/:deploymentId/signal`) remain for run observation
and human-in-the-loop approval.

### Workflows surface as UIBlocks in chat

Human-in-the-loop gates and results render as **UIBlocks** in the chat dock, not
only on a dedicated run page. `UIBlock` is a discriminated union
(`packages/blocks/src/ui-block.ts:176`, re-exported through `@workbench/chat`;
known kinds enumerated at `:292-305`). The interactive gate kinds are:

- **`choice`** — single pick, optional free-text prompt box.
- **`form`** — typed multi-field input (CL-2715), emits a `Record<name, value>`.
- **`multiSelect`** — N-of-M selection (CL-2715, `ui-block.ts:244`), emits an
  array.
- **`reviewList`** — a per-record approve/reject gate over an array of
  model-generated records (CL-2759, `ui-block.ts:257-282`): typed display
  columns, per-row `payload`, and an emitted `decisions` array covering every
  row.

The chat dock (`apps/web/src/components/WorkflowDock.tsx`) renders these via
`UIBlockView` (`:366`) from blocks built per-kind: each migrated workflow package
supplies its **own** block builder (e.g.
`@workbench/workflow-reddit-opportunity-scanner/blocks`), aggregated in
`apps/web/src/lib/dock-block-builders.ts`; any unmigrated kind falls through to
the generic `dockRunBlocks` synthesis — progress + a generic gate choice + a link
to the full run page (`packages/blocks/src/run-dock-blocks.ts:1-8`,
`dock-block-builders.ts:16`, described in-code as the "strangler fallback").

The dedicated **run-page panel** (`apps/web/src/components/WorkflowRunPane.tsx`,
per-kind panel via `loadWorkflowUI`, generic `RunConsole` fallback) is the
strangler's other half: the dock blocks and the run-page panel POST the **same
resume shapes**, and gates migrate to the dock kind by kind (a few steps are
still "kept on the run-page panel" mid-migration — see
`apps/hub/src/workflow-executor/resume-payload-registry.ts:80-97`).

## Why the divergence

The single-supervisor + in-process model exists for two measured reasons:

- **RAM.** Holding a live launched session per step (the reference model) was the
  ~3 GB sidecar RAM driver. No-op'ing inline (CL-2251) and deterministic-tool
  (CL-2252) launches, and running steps in-process, removed it.
- **Start latency.** Each per-step launch is a full deploy → pack → build →
  start-WebSocket cycle (~1-2s). Fewer launches means a materially faster
  workflow start.

Both are hub-layer / vendored-sidecar changes that use Interchange's deploy
primitive **unmodified at the orchestrator API** — the workbench keeps
`launchSession` in the orchestrator's hands but declines to call it for the step
classes that do not need it.

### CL-2782 — no-op the last launching step class (shipped)

The **deployed** (reasoning-with-tools) step class was the last one that still
launched a session. CL-2782 no-op'd that launch too — extending
`noLaunchAgentIds` from inline+deterministic to **`allStepIds`**
(`workflow-deploy.ts:239-243`) — driving workflow start from ~17s down toward
~2s. It is hub-only with zero interchange/vendored changes, and is safe because
step execution already rebuilds everything it needs at run time from the
**agent DB row + grants + hub-RPC tool rail** (the in-process path above), not
from a launched session.

**Verified on staging:** a provision-only run measured `launchSession
launches=0` — the ~17.9s of per-step launches is gone. The `toLaunchSession`
short-circuit (`workflow-deploy.ts:1158`) now returns a resolved no-op for every
step's agent id, so the orchestrator's per-step deploy → pack → session-start
cycle never runs.

**The one thing CL-2782 preserves: the per-step `agent_instance` row.** Even
with the launch no-op'd, the deployed step's `agent_instance` row stays written
(inert), because Insights attributes per-step usage by joining it. Today
`writeStepInstanceRows` is called only for deployed steps (`workflow-deploy.ts:292`),
and `activity-overview.ts` builds `workflowOwnerByInstance` (`:268-288`) by
joining `agent_instance` to `workflow_run_record` on the address prefix
`ins_<deploymentId>%`, left-joined into the usage rollup (`:321-324`). Dropping
that row to "save" the launch would blind per-step usage attribution. (Note: the
in-code comments on this join cite CL-2711/CL-2582; the CL-2705 attribution
project is the usage-attribution umbrella. The mechanism — join on the per-step
`agent_instance.id` — is what matters.)

## The vendored surface

The runtime above lives in **vendored copies** of Interchange code, because the
supervisor wiring and the child run-loop expose no seam upstream for the changes
the workbench needs. [VENDORED.md](./VENDORED.md) is the canonical catalogue;
this is the map.

**Audit handle (run before and after any pin bump — no block may disappear):**

```
git grep "WORKBENCH-LOCAL (CL-" -- apps/sidecar packages/workflow-host packages/storage-isogit
```

### Vendored packages

- **`packages/workflow-host` → `@workbench/workflow-host`** (CL-2535) — a **full
  vendored fork** of `@intx/workflow-host`, imported by the sidecar instead of
  upstream. The run-resume loop that needed changing lives deep in
  `child/run-child.ts`, with no injectable seam, so the whole package was
  vendored. Carries WORKBENCH-LOCAL blocks: the `recoverParkedRun` resume hook
  (CL-2535), the live signal watcher (CL-2537), the IPC control-channel fd move
  (CL-2585), and a crash-log interpolation fix (CL-2651). Re-sync against new
  upstream on every pin bump.
- **`packages/storage-isogit` → `@workbench/storage-isogit`** — a near-verbatim
  vendor of `@intx/storage-isogit`, imported by both hub and sidecar (both sides
  of the pack-exchange wire). Its one divergence is the CL-2663 read-vs-GC
  serialization fix in `store.ts`; everything else must stay byte-identical to
  upstream because the hub reads packs/repos the sidecar writes.
- **`packages/hub-agent` → `@workbench/hub-agent`** — an **untagged long-lived
  fork** of `@intx/hub-agent`, predating the vendor discipline. It carries real
  features upstream lacks (reconnect backoff/jitter + outbound queue from the
  CL-2405 sidecar-disconnect work; `sanitizeAddress`/agent-paths exports) but its
  divergences are **untagged**, so the audit and drift script are blind to it —
  the highest re-sync debt. Never literally re-copy.

### Vendored sidecar files

Copied from interchange's reference `apps/sidecar/src/*` + `bin/workflow-child`,
each carrying WORKBENCH-LOCAL blocks on top of the upstream copy:

- `workflow-host-wiring.ts` — supervisor wiring; carries the CL-2199/2361
  substrate-env keys, the CL-2231 undeploy inode/deployment-churn reclaim sweep,
  the CL-2340 pack-push drain barriers, the CL-2363 substrate-env guard, the
  CL-2400 register-before-spawn ordering, and the CL-2585 IPC fd `Bun.spawn`
  wiring.
- `workflow-run-pack-client.ts` — the CL-2340 delta-cursor + size-ceiling
  pack-push machinery that stops the shared sidecar OOM-ing on a wedged run.
- `workflow-substrate-factory.ts` — the per-child substrate + step-invoker
  dispatch.
- `bin/workflow-child` — the child entrypoint; wires the CL-2535 resume hook and
  CL-2503 Sentry-on-teardown.

### The pin-bump re-sync tax

The workbench tracks interchange at a **pinned SHA** and carries these fixes
locally. Because most hand-offs are **duck-typed** (a shape change won't fail the
build), a pin bump is a manual, hazard-prone re-sync:

1. `git grep "WORKBENCH-LOCAL (CL-"` before and after — confirm no block
   disappeared.
2. Diff each vendored file (and `packages/workflow-host/src/**`) against the new
   upstream and re-apply upstream changes **while preserving every
   WORKBENCH-LOCAL block** — a literal re-copy silently re-introduces the bug the
   block fixed, with a green build.
3. `scripts/check-vendored-drift.sh <prior-ref>` surfaces dropped WORKBENCH-LOCAL
   lines for review.
4. Re-run `bun run --filter @workbench/sidecar test` and
   `bun run --filter @workbench/workflow-host typecheck`, and re-verify the
   duck-typed seams (supervisor/step-invoker contract, inference-event
   discriminants, on-disk address mapping, IPC fd convention) listed in
   AGENTS.md § Dockerfile Maintenance.

See [VENDORED.md](./VENDORED.md) for the full per-file/-package catalogue and the
CL that added each block.

## Upstream & convergence

The workbench and Interchange are **converging** toward the same launch-free,
in-process multi-step model. The fork exists because the workbench got there
first (under RAM/latency pressure on a shared sidecar) and because it carries a
set of production fixes upstream has not adopted — not because the two designs
disagree. The planned path is to **retire custom surface** and adopt native
support as it lands upstream (CL-2662 is the home for that convergence work).

### Upstream drift (as of 2026-07-04)

- **Current pin:** interchange `13fb9ace3d76f453098e7ea89af030b5d897bd4a`
  (2026-06-30), which **is** `origin/main` HEAD. The workbench is **0 commits
  behind main** — a pin bump right now is a no-op, and the VENDORED.md CL-2651
  supersession audit still holds verbatim (no WORKBENCH-LOCAL block is droppable
  today).
- **The significant upstream work is on an unmerged branch:**
  `intr-156-workflow-assetdeploy-authz-sidecar-runtime-and-trivial` — a
  ~100-commit **wholesale rewrite** of the deploy/supervisor path (the "trivial
  vs multi-step" rework). It **converges toward the workbench's model**:
  - `e1f2bdc` collapses `launchSession` onto the orchestrator;
  - `e1544ed` runs child workflows **in-process under the parent substrate**
    (steps no longer launch per-step sessions — the same elimination the
    workbench did, and the same direction as CL-2782);
  - `e75b3b5` makes the supervisor the sole substrate writer;
  - plus reworks overlapping the workbench's CL-2340 (pack-push coalescing),
    CL-2585 (IPC channels), CL-2199/2361 (substrate-env keys), CL-2231 (undeploy
    teardown), and CL-2535 (drain controller), and a hub-side tool-grant rail
    analogous to the workbench's hub-RPC tool rail.
- **Also** `intr-228-sidecar-reconnect-backoff` (1 commit) overlaps the untagged
  `packages/hub-agent` reconnect machinery (CL-2405 / CL-2662).
- **Implication.** Interchange is independently arriving at the launch-free
  in-process model, so CL-2782 aligns **with** upstream's direction. But
  `intr-156` is a **new architecture**, not drop-in adoptions of the workbench's
  patches — so when it merges to main the next pin bump is a **hard re-sync of
  the entire vendored surface** (re-apply or retire every WORKBENCH-LOCAL block
  against a rewritten base). That is the natural "reduce divergence / go native"
  convergence project. **Recommendation:** hold the pin at `13fb9ac`; watch
  `intr-156` and `intr-228` for merge to main.
