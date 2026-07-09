# Deploying workflows to the hub

Workflows are git-backed assets, not hub code. A workflow is authored as a
native `@intx/workflow` definition in its own package, then **pushed** to a
running hub, which commits it to a git-backed `workflow` repo and launches it on
the sidecar. The hub imports no workflow code — adding a workflow needs no hub
change.

## Model

- **Author**: each workflow is a package under `workflows/<kind>/` named
  `@workbench/workflow-<kind>`, exporting `kind` and `workflow` (a
  `defineWorkflow(...)` definition).
- **Push**: the push script loads the workflow package by path from
  `workflows/<kind>` (the packages are orphan workspace members, so a bare
  `@workbench/workflow-<kind>` import would not resolve from `apps/hub`),
  serializes its `workflow`, and `POST`s the definition to the operator path
  `POST /api/v1/workflows/deploy` (or `POST /api/internal/workflows/deploy` for
  the service-token machine path).
- **Deploy** (hub, `persistCatalog`): validates the definition, resolves the
  tenant deploy config (the base inference source from the tenant LLM credential),
  and hands it to the exported `@intx/workflow-deploy` orchestrator. The
  orchestrator runs the capability walk and commits `workflow.json` +
  `capability-declarations.json` to the git-backed `workflow` repo; the hub writes
  the per-step DB/grant rows. Deploy is **hub-only** — it sends **no** deploy frame
  and spawns **no** supervisor, so it succeeds with the sidecar disconnected (boot
  autopublish no longer waits for a sidecar connection).
- **Run** (hub → sidecar): run-start provisions a fresh per-run deployment
  (`provisionRunDeployment`) that reads the published `workflow.json` back, mints a
  new `deploymentId`, and sends the multi-step deploy frame; the workflow-host
  supervisor then reads `workflow.json` and drives the steps, including
  `awaitSignal` human gates.

## Lifecycle: a deployed workflow has zero live instances

Deploying (or adding to a tenant) a workflow **registers a definition** — it does
**not** stand up a persistently-running service. A deployed workflow has **zero
live instances** at rest: the supervisor is brought up to drive a run and is not
expected to idle indefinitely. Workflows are generally **one-offs** (deploy, run
once, done) or **automations** (triggered on demand). Do not design a workflow
as an always-on daemon; if you need standing behaviour, that is an agent, not a
workflow.

### Restart resilience (CL-2221/2224/2225)

The supervisor's mail address lives only in the hub's in-memory `addressIndex`
(set at deploy time) and is **not** re-advertised by the sidecar on
register/reconnect — supervisors never run `startSession`. So a hub restart or
sidecar bounce drops it, and a later run-start/signal would otherwise hit
`agent is unreachable` with zero step execution.

The **hub is the control plane** and re-establishes the supervisor from its own
durable state (the `workflow` repo + the `agent_instance`/`workflow_run` rows),
never relying on the sidecar to self-restore:

- `ensureDeploymentRoutable` (`apps/hub/src/services/workflow-deploy.ts`) — an
  idempotent, per-`deploymentId`-coalesced primitive. If the supervisor address
  is already routable it is a no-op; otherwise it reads `workflow.json` back,
  rebuilds the deploy config for the **existing** `deploymentId`, and re-sends
  **only the supervisor frame**. Step sessions are deliberately not re-launched —
  they self-restore on a sidecar restart and stay alive on a hub restart, and
  re-launching them would throw `Agent already exists`.
- The run-start and signal handlers (`apps/hub/src/routes/workflow-runs.ts`) call
  it before delivering, so a trigger/signal never dead-ends on an unreachable
  supervisor.
- The reconciler (`apps/hub/src/services/workflow-reconciler.ts`) calls it for
  every active deployment on hub startup and on each sidecar `agent.reconnected`,
  single-flight-guarded.
- The sidecar deploy router (`apps/sidecar/src/workflow-host-wiring.ts`
  `deployMultiStep`) is idempotent: a re-deploy of the same address + same
  definition short-circuits (returns the existing pubkey, no second child); a
  different definition for a live address fails closed (our model mints a fresh
  `deploymentId`→address per redeploy, so that case is a contract violation).

### Known limitation: paused runs do not resume across a restart

Within a **single supervisor lifetime**, a run paused at an `awaitSignal` gate
resumes normally when the signal arrives. But a run **parked at `awaitSignal`
when the supervisor process restarts cannot be resumed** — interchange's
`@intx/workflow` runtime throws `RuntimeResumeUnsupportedError` on resume of an
`awaiting-signal` / `awaiting-timer` / `in-flight` step (`run.ts:244-257`), and
the failure is swallowed without a terminal event (the run wedges). The hub-side
machinery above re-establishes the supervisor so **new** runs work and resume
will work end-to-end once the upstream runtime re-arms awaiting-signal steps on
resume — tracked in **CL-2226**. Until then, keep human-gate waits short or
expect an interrupted gate to require a fresh run.

## Authorization

Deploy is an **operator action**. There are two authorized paths, both resolving
to the same deploy logic:

- **Session path (operators) — `POST /api/v1/workflows/deploy`.** Gated by a
  valid better-auth session **plus** the native Interchange grant check: the
  caller's principal must satisfy `authorize(... "workflow:*", "create")`. The
  global **owner** role's `*:*` grant satisfies this, so an owner deploys a
  workflow the same way it creates an agent or a credential (`agent:*`/`create`,
  `credential:*`/`create`). This is the default the admin CLI uses, via the
  operator's `SESSION_TOKEN`.
- **Service path (machine/unattended) — `POST /api/internal/workflows/deploy`.**
  Gated by the hub **service token** (`Authorization: Bearer <SIDECAR_TOKEN>`),
  the same gate the other `/api/internal` routes use. For callers with no session.

This matters because the orchestrator auto-approves the grants the posted
definition declares — so deploy must be restricted to a trusted operator (an
owner-grant holder) or a service-token holder. A plain member session is denied
with 403.

## Pushing a workflow

The hub and sidecar must be running on the **same interchange pin**, and the
tenant LLM credential (provider `openai-compatible`, name = `LLM_CREDENTIAL_NAME`
from `@workbench/agents`) must be seeded — the deploy resolves the base inference
source from it.

Run the admin CLI (`bun run admin` locally, or `bun run admin:staging` /
`bun run admin:production` from `apps/hub`): sign in, select the target tenant,
then choose the **Workflows** resource → **Push (deploy) a workflow**. The CLI
discovers the available workflow kinds from `workflows/*` and lists them — pick
one, no need to know the kind by heart. The selected tenant is threaded
automatically. On success the CLI prints the deployed kind, deployment id, and
deploy mode (`multi-step` or `trivial`). See [ADMIN_CLI.md](./ADMIN_CLI.md) for
the CLI details.

## Auto-publishing on boot

The hub can publish the build-serialized workflow definitions itself on startup,
so a merge + redeploy makes new defs live without a manual `deploy-workflow`
push. It is gated by `WORKFLOW_AUTOPUBLISH_ON_BOOT` (default off — the manual
flow still works). When on, every embedded def under
`apps/hub/generated/workflow-defs/<kind>.json` is published through the exact
same core path as the deploy route. The pass is fail-safe (a per-`(kind,
tenant)` failure is logged and skipped — a bad def never blocks startup).

Idempotency is **per `(kind, tenant)`**, not per kind. The git-backed workflow
repo is keyed by kind only, so its fingerprint is tenant-independent; the
per-tenant signal is the deployment-index row (`workflow_run`). A pair is
skipped only when the repo fingerprint matches the embedded def AND that tenant
already has an active (non-deleted) deployment of the kind. This is what lets a
tenant added to a kind's map later still receive a def whose fingerprint is
otherwise unchanged — a per-kind-only check would wrongly skip it.

By default every def targets the **global root tenant**. Because a workflow run
inherits its definition's tenant, a workflow must be published into the tenant it
should run in. `WORKFLOW_AUTOPUBLISH_MAP` (CL-2641) routes specific kinds to
specific tenants:

- It is a JSON object mapping a workflow `kind` (or the literal key `"default"`)
  to an array of tenant **slugs** (slugs, not ids, so one value works across
  staging and prod), e.g.
  `{"last30days-research":["abk-labs"],"default":["abklabs"]}`.
- Per embedded def the target slugs resolve as
  `map[kind] ?? map["default"] ?? [global root]`. An **unset/blank** env → every
  def targets the global root tenant (exact pre-CL-2641 behavior). Once the env
  **is** set, that global-root fallback no longer applies to unmapped kinds:
  they fall to `map["default"]`, and if that is an empty array (or absent) the
  def publishes **nowhere** and a warning is logged. Keep a non-empty `"default"`
  to preserve global-root routing for unlisted kinds. (Set-with-empty-default ≠
  unset.)
- Each slug is resolved to a tenant id and validated to be the global tenant or a
  descendant (the same ancestor-chain check the deploy route enforces). An
  unknown slug, an out-of-hierarchy tenant, or a per-`(kind, tenant)` publish
  failure is logged and skipped — the other targets still publish. A kind's
  resolved target list is de-duplicated, and a def that ends up with zero targets
  is warned about loudly (published nowhere is the most dangerous outcome).
- The env is parsed and validated (arktype) at config load. When it **is** set,
  malformed JSON or a wrong shape fails config load loudly; when unset or blank
  it is treated as "no map".

## Deleting and superseding a deployment

Definitions stay package-sourced; deleting manages the **deployment lifecycle**,
not the workflow code.

- **Delete / undeploy** — `DELETE /api/v1/workflows/:deploymentId`, gated by the
  same operator grant as the deploy route and scoped to the caller's tenant
  ancestor chain. It soft-deletes the `workflow_run` index row (`deletedAt` set,
  which list/start/stream already filter out) and tears down the runtime: the
  hub sends `agent.undeploy` for the deployment's supervisor address
  (`ins_<deploymentId>@<domain>`), which the sidecar's deploy router routes to
  `supervisor.shutdown()` — killing the workflow-child process and unregistering
  its mail/signal/drain routes. The same undeploy hook then **reclaims the
  deployment's on-disk footprint on the sidecar volume** (CL-2231): the
  supervisor's working-copy `workflow-run` repo plus every per-step agent-state
  repo and agent dir it owns are `fs.rm`'d — best-effort, idempotent, and
  derived from the sidecar's own `getRepoDir`/`SIDECAR_DATA_DIR`, never touching
  hub state. The backing `agent_instance` rows (supervisor + steps) are
  soft-stopped (`status = stopped`, `endedAt` set). Teardown is best-effort: the
  row is already out of the UI, so a sidecar failure logs and still returns
  `204`.

- **Redeploy supersedes** — deploying a kind into a tenant marks every prior
  active deployment of the same `(kind, tenant)` `deletedAt` and runs the same
  teardown (including the sidecar reclamation), so the newest deploy is the only
  active one. This is best-effort and transactional-safe: a supersede-teardown
  failure on an old deployment never fails the new deploy.

Neither path deletes run **history**: the hub's durable `workflow-run` repo,
step outputs, artifacts, and the DB rows are all retained — the soft-delete only
removes the deployment from the active set and stops its runtime. What the
sidecar reclaims above is its **working copy** of that state on the agent
volume, not the hub's source-of-truth record.

### Why the sidecar reclaims, and the boot reconciler (CL-2231)

Without reclamation the sidecar volume accumulated orphaned per-deployment git
repos and eventually hit `ENOSPC` — **inode exhaustion**, not bytes (repos are
file-count-heavy). The driver was deployment **churn** (repeated redeploys
without teardown), not runs: all runs of a kind share one deployment's supervisor

- step agents, so per-run cost is tiny. (Tool packages are not a factor — they
  are content-addressed and hardlinked, one copy per `package@version` shared
  across tenants.)

The undeploy hook above reclaims a deployment whose supervisor is still live in
the sidecar's in-memory map. The **boot reconciler**
(`apps/sidecar/src/boot-reconciler.ts`) closes the restart gap: before the
hub-link connects, it fetches the live deployment set from the hub
(`GET /api/internal/deployments/live`, read-only) and prunes only on-disk dirs
whose embedded `ses_<deploymentId>` token is confirmed **absent** from that set.
It also prunes durable-conversation mirrors under
`agent-conversation-state/<workflowRunSlug>/` when their deployment token is no
longer live, while preserving mirrors for live paused/terminal deployments so a
redeploy or next message can resume. It is fail-safe — any fetch/parse failure,
or an empty live set while tokenized sidecar state exists, deletes **nothing** —
and sidecar-local only. Interim operator reclaim is therefore a sidecar restart:
the boot reconciler performs the sweep before the hub-link restores sessions; do
not issue hub-driven delete RPCs for sidecar-local mirrors. The residual boot
`Reconnection rejected by governance` noise is _live_ step-agents re-establishing
(bounded, benign); eliminating step agents entirely is the **CL-2232** spike
(inline `@intx/agent` inference). See IMPLEMENTATION.md § Sidecar deployment
reclamation.

## Serialization constraint

A workflow is pushed as JSON, so every step agent must express its tools as
serializable **`capabilities`** (and an optional **`director`** ref), never as
inline tool factories — functions vanish through `JSON.stringify` and would
silently deploy a tool-less agent. The push script refuses any definition that
contains a function, so this fails fast rather than at runtime.

## Adding a new workflow

1. Create `workflows/<kind>/` as `@workbench/workflow-<kind>`, exporting `kind`
   and `workflow` (see `workflows/pain-point-collateral`).
2. `bun install` (registers the new workspace member).
3. Push it via the admin CLI's **Workflows → Push (deploy) a workflow**; the new
   kind appears in the discovered list automatically.

No hub or push-script edits are required — the push script resolves the package by
naming convention (`@workbench/workflow-<kind>`) and the hub deploy route is
workflow-agnostic.

## Deterministic (non-inference) steps

Not every step should be an LLM agent. A step that just calls a tool/API, fetches
data, or collects human input must NOT burn an inference call. **Only
genuine-reasoning steps are agents.** Three patterns cover the rest:

1. **Deterministic tool call** — use `deterministicToolStep({ id, tool, input?, after? })`
   from `@workbench/agents`. It builds a placeholder agent (`inference: { sources: [] }`,
   the reactor never runs) tagged `workbench.stepKind: 'deterministic-tool'` +
   `workbench.tool: '<name>'`; the tool stays in `capabilities` so its grants +
   package manifest are pinned at deploy. The sidecar's `createSidecarStepInvoker`
   dispatches the tagged step to `runDeterministicToolStep`, which invokes the tool
   runner directly — no `createAgent`, no `agent.send`, no inference. The step's
   resolved `input` is passed verbatim as the tool's arguments (no `input` → `{}`).
   Example: `render: deterministicToolStep({ id, tool: 'gamma_create_from_template', input })`.

2. **Fetch + human select** — `deterministicToolStep` to fetch options →
   `awaitSignal` for the pick → `deterministicToolStep` to fetch the chosen item:

   ```ts
   intake: deterministicToolStep({ id, tool: 'granola_list_notes', input: { literal: {} } }),
   select: awaitSignal({ name: 'note-selection', after: ['intake'] }),
   fetch:  deterministicToolStep({ id, tool: 'granola_get_note',
                                   input: { from: 'steps.select.output' }, after: ['select'] }),
   ```

   The panel renders the list from `steps.intake.output` and fires
   `onSignal('note-selection', { noteId })`; the select step's output IS that payload.

   **Browsing (pagination/search) is client-side over a preloaded batch, never
   in the workflow.** The DAG is acyclic and fire-once — a "next page" would be a
   cycle (re-running the list step), which no primitive supports. So the fetch
   step preloads a bounded batch (`argMap: { limit: { literal: N } }`, where `N`
   is the tool's own ceiling — `artifact_list` allows 50, `granola_list_notes`
   clamps to 30) and the panel slices/filters that batch locally. The panel MUST
   signal when a list is at its ceiling (e.g. "showing the 50 most recent") so a
   bounded search never reads as the whole corpus. `gamma-presentation-creator`'s
   3-page intake wizard (`workflows/gamma-presentation-creator/src/ui.tsx`) is the
   reference: `list-artifacts`/`list-notes` preload 50/30, the panel paginates 10
   at a time and searches artifacts by title client-side.

3. **Human input form** — for pure data collection (a URL, a prompt, an uploaded
   file parsed client-side), use `awaitSignal({ name: '<step>' })` as the step (NO
   agent, NO tool). The panel renders a form and fires `onSignal('<step>', {...})`.

### Substrate facts authors must know

- **Step output shapes differ by kind.** An agent step's output is `{ reply, turn }`.
  A `deterministicToolStep`'s output is the `ToolResult` envelope `{ callId, content }`
  (string-kind tools put JSON in `content` — decode it in the panel). An `awaitSignal`
  step's output is the received **signal payload**, addressable as `steps.<id>.output`.
- **Pass data with explicit `input` selectors.** A step with no `input` selector
  receives `null`. Selectors: `{ from: 'steps.<id>.output.path' }`, `{ from: 'trigger.payload' }`,
  `{ project, fields }`, `{ merge: [...] }`, `{ literal: ... }`.
- **`awaitSignal` cannot take an `input` selector** — only `step`/`childWorkflow` do.
  A review/selection gate's panel reads the prior step's output directly.

### Current limitations (why some "deterministic" steps stay agents)

The selector DSL has **no rename/templating selector** (`project` selects existing
field names; it cannot map `steps.generate.output.reply` → a field named `prompt`),
and there is **no `map` + deterministic-dispatch** path. So a step whose tool args
must be reshaped from an agent's free-text output, or that must write one artifact
per item, cannot be deterministic yet and remains an agent that bridges the reshape:
**gamma `render`** (`gamma_create_from_template` needs a `prompt` built from the
generate agent's output) and **ab-compare presets `persist`** (one artifact per variant,
and `content` must be a string rendered from structured output). A reshaping/templating
selector or a `map`-aware deterministic dispatch would let both become deterministic.

## API client generation

The hub now serves a `GET /openapi.json` spec, and `openapi-arktype` is vendored
as `@workbench/openapi-arktype` (`packages/openapi-arktype/`). It generates
arktype validators from that spec; the admin CLI uses its `createClient({ url })`
runtime to drive hub resources discovered from the live spec rather than
hand-writing REST calls.
