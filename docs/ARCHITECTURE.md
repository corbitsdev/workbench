# GTM Workbench — Architecture Documentation

## System Overview

The workbench is a monorepo with two runtime applications and shared packages. It runs on top of **Interchange** — an agentic OS that provides tenant management, principal identity, agent lifecycle, and inter-agent messaging.

```
Root monorepo
├── apps/web/          → React frontend (user-facing)
├── apps/hub/          → Hono backend (pipeline, persistence, API)
├── apps/sidecar/      → Interchange sidecar (agent lifecycle, hub connection)
├── packages/          → Shared types, utilities, schema, agent definitions
├── interchange/       → Dependency (agent runtime, infrastructure)
└── compose.yml        → Local dev infrastructure (PostgreSQL)
```

The current workflow is transcript/call-document-to-artifact. The broader product model is source-to-artifact: users select Sources, launch outcome-oriented Jobs, pass through Review Gates, approve Artifacts, and optionally run delivery Hooks. See [SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md) for the canonical domain terms.

## Native Workflow Runtime

Workflows run end-to-end on Interchange's **native workflow runtime**. The hub imports no workflow execution code — it deploys definitions and observes runs; Interchange owns the durable state machine, the event log, signals, timers, retries, and child workflows. This replaced the former custom hub-routed orchestration (registry, per-kind step handlers, status state machine) entirely.

> **See [WORKFLOWS.md](./WORKFLOWS.md)** for the authoritative deep-dive on the
> execution model (single-supervisor + in-process child, the launch no-op knob,
> the hub-RPC tool rail), where the workbench diverges from Interchange's
> reference runtime and why, the vendored surface, and upstream convergence. The
> sections below are the tech-agnostic summary.

### Workflows are git-backed assets, not hub code

Each workflow is its own package under `workflows/<kind>/` named `@workbench/workflow-<kind>`, exporting `kind` and a `workflow` built with `@intx/workflow`'s `defineWorkflow`. Steps are one of three classes — deployed (reasoning-with-tools) `defineAgent` agents, `inlineInferenceStep`, or `deterministicToolStep` — plus `awaitSignal` human-in-the-loop gates (see [WORKFLOWS.md](./WORKFLOWS.md) § Step classes). The shipped kinds are `ab-compare`, `ab-compare-hitl`, `attio-task-agent`, `gamma-presentation-creator`, `last30days-research`, `pain-point-collateral`, `reddit-opportunity-scanner`, and `smoke-test` (the `workflows/` directory). Adding a workflow is a new `workflows/<kind>/` package plus a push — **no hub change**.

**Control-flow portability.** Deployed runs execute on the sidecar `@intx/workflow` runtime, which supports the full primitive set (`step`, `awaitSignal`, `map`, `gate`, `sleep`, `childWorkflow`). The `gamma-presentation-creator` workflow uses `gate()` for its bounded iterative refine loop: each round's preview gate routes approval to persistence (skipping the not-selected branch's downstream closure, including later rounds' `awaitSignal` gates) or refusal to the next round. Note the in-hub linear executor (`apps/hub/src/workflow-executor/`, currently unwired from the live path) only projects `step` / `awaitSignal` / `map` and throws on `gate` — a workflow that relies on `gate()` runs on the sidecar runtime only. The projection bridge that folds run events into the polled `workflow_run_record` row is primitive-agnostic and works either way.

### Deploy: operator-gated, git-backed

Deploy is an operator action, not a user action. The admin CLI's **Workflows → Push (deploy) a workflow** imports the package, serializes its `workflow`, and POSTs the definition (operator session path `POST /api/v1/workflows/deploy`, or service-token path `POST /api/internal/workflows/deploy`). The hub's workflow-deploy service (`apps/hub/src/services/workflow-deploy.ts`) validates the definition, resolves the tenant deploy config, and runs the `@intx/workflow-deploy` orchestrator. The orchestrator commits `workflow.json` + `capability-declarations.json` to a git-backed `workflow` repo and sends the multi-step deploy frame to the sidecar, which spawns **one supervisor + one `workflow-child` subprocess** to drive the run's steps **in-process**. The orchestrator's reference model launches a live agent session per step; the workbench **no-ops** those launches for inline-inference and deterministic-tool steps (the RAM/latency win — see [WORKFLOWS.md](./WORKFLOWS.md) § The execution model). See [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md) for the full deploy guide.

A deployed workflow **registers a definition; it has zero live instances at rest**. Workflows are one-offs or triggered automations, not always-on services — the supervisor is brought up to drive a run, not to idle. Because the supervisor's mail address lives only in the hub's in-memory routing table and is not re-advertised by the sidecar on reconnect, the **hub is the control plane for restart recovery**: it re-establishes a deployment's supervisor from its own durable state (the `workflow` repo + DB rows) on run-start, signal delivery, hub startup, and sidecar reconnect (`ensureDeploymentRoutable` + the reconciler), re-sending only the supervisor frame. **Restart recovery of a parked `awaitSignal` gate is host-driven** (CL-2535): the interchange runtime declines to resume a seed log whose tail is `awaiting-signal`/`awaiting-timer`/`in-flight` and by design delegates recovery to the host. We own that host (the sidecar imports a vendored `@workbench/workflow-host` with a `recoverParkedRun` hook — see [VENDORED.md](./VENDORED.md)). On restart, a gate whose signal was **already delivered** (committed to the log before the crash) is completed from that durable signal and the run resumes; the runtime itself is unchanged. A gate **still genuinely awaiting a human** is not yet re-armed live across a restart (it falls through to the existing fail path; the live re-arm watcher + version-pinned resume is the "Resumable workflow runs" project, CL-2537). See [DEPLOYING_WORKFLOWS.md](./DEPLOYING_WORKFLOWS.md) § Lifecycle and IMPLEMENTATION.md § Supervisor restart re-establishment.

### Per-run deployment

Each **run** provisions its own ephemeral deployment (CL-2582). Run-start (`provisionRunDeployment` in `apps/hub/src/services/workflow-deploy.ts`, called from `/workflow-exec/:kind/start`) reads the published definition for the kind, mints a fresh `deploymentId`, deploys a dedicated supervisor + `workflow-run` repo for that single run, and triggers it. This gives same-kind run **concurrency by construction**: Interchange's native model is one per-deployment supervisor that dispatches a deployment's runs **serially**, so without per-run deployment a parked `awaitSignal` run would starve every other run of its kind. The change uses Interchange's deploy primitive **unmodified** (zero `@intx/*`/vendored changes) — all logic is hub-layer.

Under this model the operator deploy (above) is the **definition registry**: it publishes `workflow.json` + the `workflow_run` index row but does not serve runs. A per-run deployment writes **no** `workflow_run` row, so registry resolution never picks up an ephemeral per-run deployment. A run's deployment is **torn down on terminal status** by the projection bridge (`tearDownDeployment`, gated on the first non-terminal→terminal transition via the shared terminal-status set in `apps/hub/src/workflow-executor/run-status.ts` — never on `awaiting`, the CL-2575 invariant). On restart the reconciler re-establishes per-run deployments from non-terminal `workflow_run_record` rows (recovering the deploy principal from the kind's registry row, since the per-run deploymentId lives on the record, not on `workflow_run`); a crash-orphan janitor (`reclaimOrphanedDeployments`) reclaims deployments whose teardown did not fire. Because the per-run repo is reclaimed on terminal, `workflow_run_record` is the durable run record after the log is gone. Follow-ups (trim the now-unused shared supervisor; widen the janitor window) in CL-2584.

### Runs: an event log observed over SSE

A run is a native `WorkflowEvent` log stored in a git-backed `workflow-run` repo. The hub exposes it for observation and control via three user routes (`apps/hub/src/routes/workflow-runs.ts`):

- `GET /api/v1/workflow-runs` — tenant index of runs from the `workflow_run` table
- `GET /api/v1/workflow-runs/:deploymentId/stream` — SSE stream of the run's `WorkflowEvent`s, read via `subscribeKind` over the `workflow-run` repo
- `POST /api/v1/workflow-runs/:deploymentId/signal` — delivers a signal via `sendSignalDeliver` at the deployment's mail address

The web app folds the log into a `RunState`. The **primary live surface** is the run-state SSE stream `GET /workflow-exec/runs/:runId/state/stream`, which re-folds the log server-side and emits the authoritative `RunState` on connect and on every event (CL-2727; the web consumer replaced a laggy fixed-interval poll in CL-2779). Runs surface as **UIBlocks in the chat dock** — progress, results, and interactive gate blocks (`choice` / `form` / `multiSelect` / `reviewList`); the dedicated run-page panel is a strangler fallback (see [WORKFLOWS.md](./WORKFLOWS.md) § Workflows surface as UIBlocks). **Human-in-the-loop approval is a signal**: an `awaitSignal` gate pauses the run, a gate block (or panel) offers the choice, and the signal route resumes it.

> **Run-start** is wired on the user path `POST /api/v1/workflow-exec/:kind/start` (`apps/hub/src/routes/workflow-run-records.ts`), which provisions a per-run deployment (see § Per-run deployment) and triggers it; the seeded `workflow_run_record` row is the polled state the projection bridge advances. Interchange stays pinned to plain upstream (no fork).

## Interchange Integration

The hub deploys Interchange's `createApp`, which registers all tenant, principal, grant, agent, and instance routes. The workbench is a multi-tenant system built on top of Interchange's identity and delivery primitives.

### Tenancy Model: Shared Global Org Tenant

The workbench runs on a **single shared global org tenant**, seeded once at hub boot. Its name/slug/domain come from env (`GLOBAL_TENANT_{SLUG,NAME,DOMAIN}` via `requireEnv`) — never hardcoded, so the same code produces a different org per deployment. The seed (`seedGlobalTenant`) is idempotent and race-safe across replicas (unique-slug catch-and-reselect) and fails loud if the tenant exists but is missing its system roles.

Every same-domain user **auto-joins the global tenant as a `member` principal** (`ensureGlobalMember`, race-safe via the unique `principal (tenantId, kind, refId)` constraint). The `member` role is intentionally grant-less: product reads are principal-scoped and never consult the Interchange grant system, so a `member *:read` grant would only widen blast radius in a shared tenant. Owner (`*:*`) and admin (`*:{read,create,manage}`) grants remain for org admins.

**Workbenches are sub-tenants** of the global tenant (`parentId = globalTenantId`). Because `getAncestorChain` resolves nearest-tenant-first, an LLM credential stored once at the org level resolves down the hierarchy into every workbench via `resolveCredentialRequirement` — no per-workbench credential duplication.

`getUserContext` resolves the caller's working context as their member principal in the global tenant (by config slug). This single function gates every workflow/artifact route. The former per-user personal-tenant model (slug `user-{userId}`) and all its provisioning/repair paths have been removed.

> **Forward path (substrate for multi-tenant SaaS):** this builds the per-org shape SaaS needs — org tenant → member principals → sub-tenant workbenches → tenant+principal-scoped data + credential inheritance. Going multi-tenant later is additive: replace the single env-seeded org with per-customer org provisioning and resolve the user's org by membership instead of the one constant. Treat the `GLOBAL_TENANT_*` env seed as a deliberately temporary v1 mechanism.

### Agent Definitions and Signup Provisioning

**Agent templates** (`@workbench/agents`) are materialized as first-class Interchange agent definitions in the global tenant at hub boot via `seedAgentTemplates(db)`. This is idempotent — re-boot is a no-op. Definitions become visible and editable in admin-ui automatically.

| Template   | Role                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| **Myra**   | Personal Chief of Staff / Executive Assistant for each user             |
| **Oat**    | Processes Granola calls into call document artifacts when prompted      |
| **Freddy** | Firecrawl-backed web research agent                                     |
| **Walter** | Content writer — turns briefs and research into polished GTM collateral |
| **Loop**   | Iterative refinement agent                                              |

The enabled-template set (which definitions members auto-get on join) defaults to `['myra']` in code. No runtime config.

**On join** (`user.create.after` / `session.create.after` / `GET /me`):

1. `ensureGlobalMember` — creates the user's `member` principal in the global tenant (idempotent, race-safe via unique constraint)
2. For each enabled template definition: creates a per-user **instance** keyed on `(definitionId, memberPrincipalId)` — idempotent, no duplicate instances on re-login

Instance creation uses Interchange-native instance APIs; no bespoke per-user agent creation. The org-level credential is inherited at launch time from the global tenant's ancestor chain via `resolveCredentialRequirement` — no per-user credential entry.

Myra instances are owned per member via the hub-owned `member_agent_instance` mapping (`memberPrincipalId → instanceId`, `templateKey: 'myra'`) — **not** `(tenantId, name)`: in a shared tenant every member's instance is named "Myra," so name-based lookup would hand one user's instance to everyone. The join-time provisioner creates exactly one Myra mapping; `POST /v1/me` keys auto-relaunch off it.

**Multi-thread Myra (CL-2309).** Multiple chat "threads" are simply multiple `member_agent_instance` rows for the same member with `templateKey: 'myra'` — each a normal `agent_instance` + sidecar harness (tools, skills, mail, tracing), the same stack as every other agent. There is **no separate Myra runtime**; the feature is a chat shell over ordinary instances. The hub exposes thread CRUD at `GET/POST/PATCH/DELETE /v1/me/myra/threads` (mapping `id` is the thread id; create launches a new instance + session, delete ends the session and removes the mapping/instance/grants). The first thread is the join-provisioned instance; `GET /v1/me`'s `paInstanceId` (a `findFirst`) remains that instance and is the web client's default-thread fallback.

Both Myra and Oat use custom directors wrapping `createDefaultDirector` to filter inbound senders before inference.

**Uniform agent lifecycle.** There is no host-driven per-instance scheduler. Every agent is interactive and recover-on-open: it acts on inbound mail and is relaunched when needed, rather than on a timer. Myra is the only agent auto-relaunched on user activity (via `POST /v1/me`); other agents recover on the next open. A periodic wedge-sweep reconciler additionally relaunches **any** instance left active-but-unroutable after a sidecar restart, so a wedged non-interactive agent no longer waits for an open. Recurring work (e.g. periodic Granola ingestion) is moving to **workflows**, which will own native scheduling. See the Session Liveness and Relaunch section in IMPLEMENTATION.md for the disconnect and wedge-sweep reconcilers that keep a sidecar restart from wedging an instance.

### Credential and Grant Model

Credentials and grants follow Interchange's model exactly. The workbench does not define its own credential abstraction.

**Credentials** are stored in Interchange's `credential` table. Every credential belongs to a tenant and has a `providerId` (pointing to a `provider` row naming the integration, e.g. `"openai-compatible"`). Credentials intended for agent resolution are stored **tenant-owned** — `principalId: null`. This is required for `source: 'tenant'` resolution to work.

**Agent credential requirements**: Each agent definition declares `credentialRequirements` — a list of `{ providerName, source, name? }` entries describing what the agent needs at launch. Interchange resolves these automatically at launch time by walking the tenant hierarchy. The workbench never passes credential IDs to the session launch call.

**Credential resolution at launch time**: Interchange's `resolveCredentialRequirement` walks up the tenant ancestor chain looking for a credential matching `providerName + source` (and optionally `name`). The workbench relies entirely on this resolver — it never builds inference sources manually or passes credential IDs through the launch call.

**Myra's credential requirement**: `{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }`. The credential named `'Myra LLM'` is stored tenant-owned (org level or per-workbench); Interchange resolves it down the ancestor chain at launch time.

**Credential setup**: An org admin creates the LLM credential once at the global tenant level via `@intx/admin-ui`. Members never enter API keys. The credential resolves down the ancestor chain to every member's instance at launch time via `resolveCredentialRequirement`.

**Grants** (manage access, not resolution): The hub writes a `grant` row giving the creating principal manage access to the credential record (`resource: credential:{id}`, `origin: creator`). This grant enables the Settings UI to delete/update the credential. It is separate from resolution — Interchange resolves credentials from the tenant, not from grants to instance principals.

**Credential ownership in a shared tenant**: because every member is a principal in the same global tenant, `GET`/`PATCH /v1/tenants/:tenantId/credentials` are scoped to the caller's owned credentials. The decision is delegated entirely to Interchange's authorization evaluator (`authorize`/`evaluateGrants` from `@intx/authz`) against the resource `credential:<id>` — no hand-rolled grant interpretation. A member's `creator` grant authorizes their own credentials; an admin/owner wildcard grant authorizes all. "Shared org" credentials (e.g. a tenant-owned `Myra LLM` key seeded at the org level with no creator grant) are not enumerable/editable by ordinary members via this route but remain resolvable at launch (resolution is not grant-gated).

**Workflow step credentials**: A native workflow declares its inference needs per step in its `defineWorkflow` definition. At deploy time the hub's workflow-deploy service resolves the tenant deploy config (the base inference source from the tenant LLM credential) and the orchestrator binds it; credentials remain tenant-owned and resolved down the ancestor chain, never passed as IDs through the deploy call.

**Grant-based resource ownership (generalized)**: The same "creator holds a manage grant; mutations gated by `authorize`; reads are broader than writes" pattern applies to more than credentials. Any hub-owned, per-principal-managed resource follows it: on create, the hub writes a `grant` row (`resource: <kind>:<id>`, `action: manage`, `origin: creator`) for the creating principal; `PUT`/`DELETE` call `authorize(grantStore, principalId, tenantId, "<kind>:<id>", "manage")` and 403 unless the effect is `allow`; list responses expose a per-caller `canManage` flag computed from `collectGrants`. Delegation is a second `manage` grant to another principal (owner-only). **Gamma templates** (`workbench_template`, kind `gamma`) are managed this way: reads walk the tenant ancestor chain (anyone in the workbench can use a template), while create/update/delete/delegate are grant-gated to the owner — served over `GET/POST/PUT/DELETE /api/v1/gamma-templates` and `POST /api/v1/gamma-templates/:id/delegates`. An admin/owner wildcard grant authorizes management of any template, exactly as with credentials.

### Credentials at Rest

Credential secrets are stored as plaintext at the application layer in Interchange's `credential` table. Encryption at rest is handled by the storage layer, not by application code. The hub reads secrets directly and passes them to agents without any encrypt or decrypt step. The application-layer encryption package (`@workbench/hub-crypto`) was removed.

## Admin Surface

All org management (credentials, providers, agent definitions, instances, principals, roles, grants) is handled by **`@intx/admin-ui`** — Interchange's native admin SPA. It is deployed as a separate subdomain (`admin.*`) pointed at the hub's `/api` routes, which are already mounted by `createApp`. Admins authenticate via admin-ui's email/password login; this is separate from the workbench's Google session.

The workbench product app contains no **org** management UI — no credential settings pages, no principal management, no agent provisioning forms. It does surface management for **user-owned content** that the admin SPA has no concept of: e.g. `/settings/tools/:id` lets a member manage their own Gamma templates (create/edit/delete, owner-gated via the grant model above). This is product content owned by a principal, not org/tenant administration.

## Component Diagram

### Frontend (`apps/web/`)

- **Dashboard**: Entry point. Start a workflow run, resume session, artifact browser.
- **Workflow dock + chat**: A run surfaces as UIBlocks in the chat dock (`WorkflowDock`) — progress, results, and interactive gate blocks — alongside chat with Myra or workspace agents via `@workbench/chat` components.
- **Run-page panel**: A per-kind panel (`WorkflowRunPane`, with a generic `RunConsole` fallback) that renders a run from its folded state — step timeline, outputs, and gate affordances. It is the strangler fallback as gates migrate to dock blocks.

**State Management**: The frontend uses TanStack Query for all server state. It subscribes to the run-state SSE stream (`GET /workflow-exec/runs/:runId/state/stream`), which delivers the server-folded `RunState` directly; signals (approvals) are sent via the signal route. No local session state is held in React context.

**Kind-aware blocks over a kind-agnostic core**: The run state itself is kind-agnostic — a fold of the native `WorkflowEvent` log. Rendering is layered: unmigrated kinds fall through to a generic progress/gate/link synthesis (`dockRunBlocks`), while a migrated workflow package supplies its **own** dock-block builder (and optional run-page panel) deriving richer, kind-specific UIBlocks. The dock blocks and the run-page panel POST the same resume shapes, so a gate can move between them without a protocol change. See [WORKFLOWS.md](./WORKFLOWS.md) § Workflows surface as UIBlocks.

### Backend (`apps/hub/`)

- **Authentication**: Google OAuth with optional domain allowlisting. Session state stored in secure HTTP-only cookies. CORS origins configurable via trusted origins.
- **Interchange App**: Hub calls `createApp` from Interchange, registering all tenant/principal/grant/agent/instance routes.
- **Workflow Deploy Route**: `POST /api/internal/workflows/deploy` (service-token auth) — validates a posted native definition and hands it to the `@intx/workflow-deploy` orchestrator. The hub imports no workflow execution code.
- **Workflow Run Routes**: `GET /api/v1/workflow-runs` (tenant index), `GET /api/v1/workflow-runs/:deploymentId/stream` (SSE event log), `POST /api/v1/workflow-runs/:deploymentId/signal` (HITL approval) — see the Native Workflow Runtime section.
- **Collateral Generation Route**: `POST /collateral-generation` — accepts `inputArtifactIds[]` and `outputTypes[]`; each output type generates independently in parallel via `@intx/agent`; results stored as artifact rows with `kind = output type`
- **Agent Runtime**: Uses `@intx/agent` (from `interchange/`) with structured JSON outputs
- **Persistence Layer**: PostgreSQL + Drizzle ORM

### Sidecar (`apps/sidecar/`)

- **Agent Orchestration**: Connects to the Interchange hub via WebSocket (`HUB_WS_URL`) and manages the lifecycle of running agents on behalf of the workbench
- **Identity**: Each sidecar has a stable `SIDECAR_ID` (opaque string slug, e.g. `gtm-staging`) and a `SIDECAR_TOKEN` for hub authentication
- **On-disk state**: Maintains per-agent git repositories and key pairs in `SIDECAR_DATA_DIR`. This directory must be backed by a persistent volume in production — loss of this data prevents the sidecar from reconnecting its agents to the hub. A deployment's footprint here is reclaimed when it is undeployed/superseded, and a fail-safe boot reconciler prunes orphans left by a restart, so deployment churn cannot exhaust the volume (CL-2231); reclamation is sidecar-local and never mutates the hub's durable state. See IMPLEMENTATION.md § Sidecar deployment reclamation.
- **Hub relationship**: The hub also maintains on-disk state (`HUB_DATA_DIR`) and requires a persistent volume for the same reason. If either side loses state, the sidecar–hub trust relationship must be re-established

### Shared Packages (`packages/`)

- **workbench-shared**: Types crossing the web/API boundary
- **agents** (`@workbench/agents`): Agent definitions, system prompts, custom directors, `InstanceEvent` → `ChatMessage` adapter
- **chat** (`@workbench/chat`): Transport-agnostic chat UI components
- **tools-\*** (`@workbench/tools-*`): Self-contained tool packages. Each exports tool definitions, AgentTool handlers, and a `*_HUB_TOOLS` registry entry. The hub spreads these entries into its registry — no tool logic lives in the hub or sidecar themselves.

### Hub-Proxied Tool Execution

Tool execution is split across three layers with a strict separation of concerns:

| Layer                                 | Responsibility                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| **Tool package** (`packages/tools-*`) | Tool definition (model-visible schema), AgentTool handlers, hub registry entry |
| **Hub** (`/api/internal/tools/run`)   | Credential resolution from Interchange, dispatches to tool package handler     |
| **Sidecar** (`HubToolRunner`)         | Generic proxy — forwards all tool calls to hub; zero tool-specific code        |

**Adding a new tool** requires only:

1. Create `@workbench/tools-<name>` — export `*_HUB_TOOLS` with definition + providerName + `createTools` factory
2. Spread `*_HUB_TOOLS` into hub's `KNOWN_TOOLS` in `apps/hub/src/lib/tool-registry.ts`
3. Register the provider + credential in Interchange

No sidecar changes. No hub execution logic changes. Credentials come from Interchange's tenant credential store at execution time.

See [CREATING_AGENTS_AND_TOOLS.md](./CREATING_AGENTS_AND_TOOLS.md) for the full step-by-step guide to building tool packages, agents, and workflows.

**Tool visibility per agent** is controlled by `agent.capabilities.tools` — a list of tool names set when the agent is provisioned or updated. The hub builds `HarnessConfig.tools` from this list at launch time. An agent only sees tools explicitly listed in its capabilities, regardless of what credentials the tenant has configured.

**Tool authorization** is separate from visibility and follows Interchange's grant model: every tool call is gated by a `grant` row (`resource: tool:<name>`, `action: invoke`, `effect: allow`, `origin: system`) on the instance principal. The hub reconciles these rows from `capabilities.tools` at launch (`persistInstanceToolGrants`) so the persisted grant set always matches the configured tool list. Authorization is trust-by-configuration — any tool in `capabilities.tools` is allowed; there is no per-invoker delegation. Interchange's `grantRequirements` only models `creator`/`invoker` delegation (no tenant/system source), so trusted infrastructure tools are expressed as directly-persisted grants instead, the same way admin-ui creates grants.

These grants **must** be persisted, not synthesized in memory at launch. Interchange's reconnect path (`collectGrants` → `sendGrantsUpdate`) re-sends only what it reads from the `grant` table, so in-memory tool grants are dropped on every sidecar reconnect — the agent then fails every tool call with `No matching grants for tool:<name>`. Persisting makes launch and reconnect agree, since both resolve grants the same way.

### File Parsing (model-agnostic document understanding)

An agent's ability to read an attachment is set by its inference **adapter**, not just its model: the Anthropic and Google adapters marshal document (PDF) content blocks natively; the openai-compatible adapter (Myra's, on kimi via opencode-zen) throws on any document block. So a document can never be sent inline to Myra.

The **File Parser** decouples "file understanding" from "the chat model's multimodal capability." It is a dedicated agent definition bound to a doc-capable adapter, seeded but never surfaced in the user agent catalog. It runs as a **one-shot in-hub inference turn** (not a launched session): the document's bytes are sent as an attachment and the turn returns the extracted text.

Two paths reach it:

- **User uploads a document to Myra** — the client diverts the document away from the inline-mail path to an upload endpoint, which stores it as a file **artifact**, runs the File Parser, and returns the extracted text. The client folds that text into the message (invisible to the rendered bubble) so Myra reasons over it, and shows the document as a chip. The document is never sent inline.
- **An agent reads an existing file artifact** — a `parse_file` tool (hub-backed) runs the same parse turn on demand over an artifact the agent references.

The composer's attachment gate is **additive**: a parser-equipped agent accepts documents so a user can attach one, while the agent's _native_ capability — and the inline-mail guard that enforces it — stays unchanged (images-only for Myra). Documents therefore only ever flow through the parser, never inline to a doc-incapable model.

## Skill Library

Skills are first-class **Interchange assets** (`kind: 'skill'`). Their lifecycle is owned entirely by the Interchange asset substrate — the workbench never reimplements asset storage or versioning.

### Storage model

Each skill is an Interchange asset row (`asset` table, Interchange-owned) backed by a git repository on disk managed by `RepoStore`. The git repo holds all skill files under an `<assetName>/` path prefix. The entrypoint file `<assetName>/SKILL.md` carries Interchange-injected YAML frontmatter consumed by `skillKindHandler`; the workbench strips this frontmatter before returning content to the UI.

Skills are committed to `refs/heads/main` via `AssetService.populateAsset`. `AssetService.createAsset` initialises the git repo; `populateAsset` commits the tree content. Each commit is a skill **version** — there is no separate version store; version history is the git log.

### Access model

The `asset` table is Interchange-owned and cannot carry workbench sharing metadata, so access scope lives in a hub-owned `skill_access` table (one row per skill asset: `scope`, `owner_user_id`, `owner_principal_id`). The physical tenant the asset lives in (`asset.tenantId`) is the share target.

Visibility is a pure rule (`isSkillVisible`): a skill is visible to a viewer when the asset's tenant is in the viewer's tenant **ancestor chain** (`getAncestorChain`, walking workbench → org → root) **and** either it is `tenant`-scoped (or a legacy row with no `skill_access` entry, treated as tenant-wide) or it is `private` and `owner_user_id` matches the viewer. Owner identity is keyed by user id, not principal id, because principals are per-tenant and a user views from different tenants.

`listShareTargets` returns the ancestor tenants the caller is an active member of (closest first); the create-time toggle offers these plus "Just Me" (private).

**Managing a shared skill** (delete/update/restore) resolves the asset across the actor's ancestor chain — not just the working tenant, since a shared skill lives in a parent tenant — and authorizes via `canManageSkill`: ownership is keyed on the stable **user id** recorded in `skill_access` (legacy rows with no entry fall back to the creator principal). Keying on user id rather than the per-tenant principal is required because the same user has a different principal in each tenant. Attaching/detaching a skill to an agent enforces the same `isSkillVisible` read rule, so a private skill the caller cannot see cannot be attached to (and read through) an agent.

### Routes

| Method   | Path                               | Action                                                        |
| -------- | ---------------------------------- | ------------------------------------------------------------- |
| `GET`    | `/skills`                          | List skills visible to the caller (access-filtered)           |
| `GET`    | `/skills/share-targets`            | Tenants the caller may share into (ancestor chain)            |
| `GET`    | `/skills/:assetId`                 | Fetch skill metadata + full file tree                         |
| `GET`    | `/skills/:assetId/versions`        | List version history (git log)                                |
| `POST`   | `/skills`                          | Create or update a skill (accepts `scope`)                    |
| `POST`   | `/skills/:assetId/restore`         | Restore a prior version as a new commit (creator-only)        |
| `DELETE` | `/skills/:assetId`                 | Delete skill — removes asset row, `skill_access` row, git dir |
| `POST`   | `/agents/:agentId/skills/:assetId` | Attach a skill to an agent                                    |
| `DELETE` | `/agents/:agentId/skills/:assetId` | Detach a skill from an agent                                  |

`/skills/share-targets` is registered before `/skills/:assetId` so the literal path is not captured as an asset id.

### Versioning

`listSkillVersions` reads the asset's git log on `refs/heads/main`; `toVersionEntries` assigns sequential numbers (v1 = oldest commit, newest gets the highest) and exposes a 7-char short sha. The endpoint paginates (`limit`/`offset`, newest first) and returns `total` so the detail page bounds what it renders; version numbers stay absolute regardless of the page window. `restoreSkillVersion` reads the tree at a target commit and writes it back to `refs/heads/main` as a new commit via `populateAsset`, so a restore is itself a new version. Restore is creator-only (matching delete); the route returns 403 otherwise.

### Deletion

`AssetService` has no delete method (assets are git-backed immutable versions). Deletion is a two-step workbench operation:

1. Delete the `asset` row — `agent_asset` rows cascade automatically via FK `onDelete: 'cascade'`
2. Remove the git repo directory via `RepoStore.getRepoDir()` + `fs.rm({ recursive: true })`

Only the asset's `creatorPrincipalId` may delete it; the route returns 403 otherwise.

### File tree reading

`GET /skills/:assetId` walks the git tree with `isomorphic-git`'s `git.walk`, resolving `refs/heads/main` explicitly (HEAD is not set in Interchange-created repos). The map callback returns `undefined` for directory entries (to allow descent) and `null` only to prune; returning `null` for a directory would prune the entire subtree. Binary files are returned without a `content` field.

### Known forward items

- Skill version number is shown on the detail page only; surfacing it on library cards would require a git-log per skill on the list path
- Agent attachment is owned by the hub via `agent_asset` FK; no detach method exists in `AssetService` so detach deletes the row directly

## Database Schema

Defined in `apps/hub/src/db/schema.ts` using Drizzle ORM.

| Table              | Key Columns                                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact`         | `id` (UUID PK), `kind` (CollateralType), `sessionId` (UUID FK, nullable), `workflowId` (UUID FK, nullable), `content`, `createdAt`                                                                                                                            |
| `workflow_run`     | `id` (UUID PK), `deploymentId` (text, nullable — the `@intx/workflow-deploy` deploymentId for natively deployed runs; powers the `GET /api/v1/workflow-runs` index), `tenantId`, `principalId`, `kind`, `status`, `input`, `output`, `createdAt`, `deletedAt` |
| `enabled_workflow` | `id`, `tenantId`, `principalId`, `kind` — which workflow kinds a principal has enabled                                                                                                                                                                        |

### Artifact Model

`artifact` is the single store for all workflow and agent outputs:

- `sessionId` is nullable (workflow-level artifacts have no session)
- `workflowId` links artifacts to collateral generation workflows
- `kind` is typed as `CollateralType` (case-study, one-pager, email-draft, call-document, etc.)
- `content` holds the human-readable body; `source` is an opaque JSON bag for structured payloads alongside it. For `kind: 'research'`, `source.brief` carries the typed `ResearchBrief` (clusters, best-takes, stats, citations) that the UI renders richly, with `content` as the prose/markdown fallback. The renderer validates `source.brief` at the boundary and degrades to markdown if absent.

## Data Flow

1. **Oat processes Granola calls** → Creates call document artifacts in the `artifact` table
2. **User triggers Collateral Generation** → `POST /collateral-generation` with `inputArtifactIds[]` and `outputTypes[]`
3. **Parallel generation** → Each output type generates independently via `@intx/agent`
4. **Artifacts stored** → Results saved as `artifact` rows with `kind = output type` and `workflowId` FK
5. **Review/Export** → User reviews artifacts, copies or downloads final output

## Terminology

- **Workspace**: The user-facing organizational unit in GTM Workbench. Every user belongs to one workspace. Use "workspace" in UI copy.
- **Tenant**: The Interchange concept that a workspace maps to 1:1. Use "tenant" in backend/API code, "workspace" in UI and product copy.
- **Personal Tenant**: Removed. The former per-user personal tenant model (`user-{userId}`) was replaced by the shared global org tenant + per-user instances of enabled agent definitions.
- **Source**: Input material selected for a job, such as a call document, uploaded file, brain/context file, URL, or prior artifact reused as input.
- **Workflow**: A reusable recipe or definition. Workbench owns the product-facing offering; Interchange owns deployable workflow execution.
- **Job**: One execution/run of a workflow against selected sources and options. Jobs are what users resume, review, and complete.
- **Review Gate**: A human decision point in a job, such as selecting input artifacts, confirming findings, approving collateral, or confirming delivery.
- **Artifact**: An output produced or curated by a job or agent. Artifacts can later be selected as sources for new jobs, but remain outputs with provenance.
- **Hook**: Optional delivery action after review, such as copy/export, draft email, schedule social post, or webhook/custom action.

## Design Decisions

- **Interchange as the foundation**: The hub deploys `createApp` from Interchange rather than building its own tenant/identity/agent infrastructure.
- **Shared global org tenant**: All users are member principals of one env-named global org tenant seeded at boot; agent definitions are seeded at the same time via `seedAgentTemplates`; workbenches are sub-tenants and per-user Myra instances live in the global tenant. Replaced the former per-user personal-tenant model (which was fragile — provisioned from three paths — and not the SaaS substrate). Data is kept private by per-principal scoping, not by per-user tenants.
- **Artifact-centric model**: All outputs — from agents and workflows — are stored as `artifact` rows with provenance. Artifacts can be reused as inputs.
- **Native workflow runtime**: Workflows are native `@intx/workflow` definitions deployed as git-backed assets and executed by Interchange's runtime; the hub does not implement workflow orchestration. Adding a workflow needs no hub change.
- **Parallel generation**: Each collateral output type in a Collateral Generation workflow generates independently in parallel via separate agent calls.
- **Paste-first intake**: Manual transcript paste remains supported as a secondary path; Oat-driven Granola processing is the primary intake.
- **Human-in-the-loop**: Every major stage requires human approval. No fully automated pipeline.
- **Persistent sessions**: Full workflow state is saved to PostgreSQL. Resumable.

## Known Debt & Forward Direction

- **`pain_point` should be an Artifact, not its own table**: pain points are workflow outputs and belong in the unified `artifact` model (with provenance), not in a dedicated `pain_point` table. The tenancy migration deliberately does not entrench it (it carries no tenant/principal columns and rides `workflow_run`).
- **Avoid per-workflow database structures**: workflow-specific tables do not scale across workflow kinds. The hub-side tables (`enabled_workflow`, `workflow_run`) are intentionally generic (keyed by a `kind` string); new workflow kinds must not add bespoke tables. Run state itself lives in Interchange's native `workflow-run` event log, not the hub.
- **`/me` field rename**: the `/me` response still returns the working (global) tenant id under the legacy field name `personalTenantId`; rename to `tenantId` across hub + web is a pending follow-up.
- **Tool changes require definition edit + relaunch**: there is no PATCH route for live tool updates. To change an agent's tool list, edit the agent definition in admin-ui and relaunch the instance. The `relaunchRunningAgentInstancesForToolUpdate` code path was removed.

---

**API Reference**: See [API.md](./API.md) for detailed endpoint documentation and data type specifications.
