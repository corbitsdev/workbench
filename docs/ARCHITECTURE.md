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

| Template   | Role                                                              |
| ---------- | ----------------------------------------------------------------- |
| **Myra**   | Personal Chief of Staff / Executive Assistant for each user       |
| **Oat**    | Processes Granola calls into call document artifacts when prompted |
| **Freddy** | Firecrawl-backed web research agent                               |
| **Larry**  | last30days research agent — mines HN/GitHub/Reddit/X/YouTube/Bluesky/web for recent signal and emits a structured research brief |
| **Walter** | Workflow orchestration agent                                      |
| **Loop**   | Iterative refinement agent                                        |

The enabled-template set (which definitions members auto-get on join) defaults to `['myra']` in code. No runtime config.

**On join** (`user.create.after` / `session.create.after` / `GET /me`):

1. `ensureGlobalMember` — creates the user's `member` principal in the global tenant (idempotent, race-safe via unique constraint)
2. For each enabled template definition: creates a per-user **instance** keyed on `(definitionId, memberPrincipalId)` — idempotent, no duplicate instances on re-login

Instance creation uses Interchange-native instance APIs; no bespoke per-user agent creation. The org-level credential is inherited at launch time from the global tenant's ancestor chain via `resolveCredentialRequirement` — no per-user credential entry.

Myra instances are keyed on `(definitionId, memberPrincipalId)` — **not** `(tenantId, name)`: in a shared tenant every member's instance is named "Myra," so name-based lookup would hand one user's instance to everyone.

Both Myra and Oat use custom directors wrapping `createDefaultDirector` to filter inbound senders before inference.

**Uniform agent lifecycle (CL-1696).** There is no host-driven per-instance scheduler. Every agent is interactive and recover-on-open: it acts on inbound mail and is relaunched when needed, rather than on a timer. Myra is the only auto-relaunched agent (via `GET /v1/me`); other agents recover on the next open. Recurring work (e.g. periodic Granola ingestion) is moving to **workflows**, which will own native scheduling. See the Session Liveness and Relaunch section in IMPLEMENTATION.md for the disconnect reconciler that keeps a sidecar restart from wedging an instance.

### Credential and Grant Model

Credentials and grants follow Interchange's model exactly. The workbench does not define its own credential abstraction.

**Credentials** are stored in Interchange's `credential` table. Every credential belongs to a tenant and has a `providerId` (pointing to a `provider` row naming the integration, e.g. `"openai-compatible"`). Credentials intended for agent resolution are stored **tenant-owned** — `principalId: null`. This is required for `source: 'tenant'` resolution to work.

**Agent credential requirements**: Each agent definition declares `credentialRequirements` — a list of `{ providerName, source, name? }` entries describing what the agent needs at launch. Interchange resolves these automatically at launch time by walking the tenant hierarchy. The workbench never passes credential IDs to the session launch call.

**Credential resolution at launch time**: Interchange's `resolveCredentialRequirement` walks up the tenant ancestor chain looking for a credential matching `providerName + source` (and optionally `name`). The workbench relies entirely on this resolver — it never builds inference sources manually or passes credential IDs through the launch call.

**Myra's credential requirement**: `{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }`. The credential named `'Myra LLM'` is stored tenant-owned (org level or per-workbench); Interchange resolves it down the ancestor chain at launch time.

**Credential setup**: An org admin creates the LLM credential once at the global tenant level via `@intx/admin-ui`. Members never enter API keys. The credential resolves down the ancestor chain to every member's instance at launch time via `resolveCredentialRequirement`.

**Grants** (manage access, not resolution): The hub writes a `grant` row giving the creating principal manage access to the credential record (`resource: credential:{id}`, `origin: creator`). This grant enables the Settings UI to delete/update the credential. It is separate from resolution — Interchange resolves credentials from the tenant, not from grants to instance principals.

**Credential ownership in a shared tenant**: because every member is a principal in the same global tenant, `GET`/`PATCH /v1/tenants/:tenantId/credentials` are scoped to the caller's owned credentials. The decision is delegated entirely to Interchange's authorization evaluator (`authorize`/`evaluateGrants` from `@intx/authz`) against the resource `credential:<id>` — no hand-rolled grant interpretation. A member's `creator` grant authorizes their own credentials; an admin/owner wildcard grant authorizes all. "Shared org" credentials (e.g. a tenant-owned `Myra LLM` key seeded at the org level with no creator grant) are not enumerable/editable by ordinary members via this route but remain resolvable at launch (resolution is not grant-gated).

**Per-step workflow assignments**: Unlike agents, whose credential requirements resolve implicitly by name, a workflow declares requirements **per step** and binds an explicit tenant credential to each step when it is added to a workbench. Workflow enablement + its assignments are scoped **per principal** — the `workbench_workflows` row is unique on `(tenant_id, principal_id, kind)` — so in the shared tenant one member's enablement and credential/tool bindings cannot overwrite another's, and a step never resolves another member's LLM key. At run time the hub resolves the bound credential by ID (`resolveCredentialById`, scoped to the tenant ancestor chain) rather than by name — so different steps can use different credentials — and falls back to name-based resolution for installs predating assignments. Credentials are still tenant-owned and encrypted as above; only the selection mechanism differs.

### Credentials at Rest

Credential secrets are stored as plaintext at the application layer in Interchange's `credential` table. Encryption at rest is handled by the storage layer, not by application code (see CL-1521). The hub reads secrets directly and passes them to agents without any encrypt or decrypt step. The application-layer encryption package (`@workbench/hub-crypto`) was removed in CL-1537.

## Admin Surface

All org management (credentials, providers, agent definitions, instances, principals, roles, grants) is handled by **`@intx/admin-ui`** — Interchange's native admin SPA. It is deployed as a separate subdomain (`admin.*`) pointed at the hub's `/api` routes, which are already mounted by `createApp`. Admins authenticate via admin-ui's email/password login; this is separate from the workbench's Google session.

The workbench product app contains no management UI — no credential settings pages, no principal management, no agent provisioning forms.

## Component Diagram

### Frontend (`apps/web/`)

- **Dashboard**: Entry point. New workflow, resume session, artifact browser.
- **Collateral Generation**: Select input artifacts and output types, trigger generation.
- **Artifact Review**: Card-by-card review, approval, inline improvement.
- **Final Export**: Assembled collateral with copy/export actions.
- **Chat**: Chat with Myra or workspace agents via `@workbench/chat` components.

**State Management**: The frontend uses TanStack Query for all server state. Each stage page queries the workflow endpoint (`GET /workflows/:id`) and mutates via step endpoints (`POST /workflows/:id/steps`). No local session state is held in React context.

**Generic host, workflow-owned steps**: A workflow is generic — a series of steps with a lifecycle `status` and granted capabilities. The host (hub + web) is domain-agnostic; each workflow's step shapes, step inputs/outputs, current-step mapping, and UI live in its own package. On the backend, `WorkflowType` (`@workbench/workflow-core`) carries `serializeStepState(ctx)` (builds the workflow's named steps from generic run state) and `deriveCurrentStep(status)` (maps the lifecycle status to a step name). The `GET /workflows/:id` handler delegates to these — it never branches on workflow kind or hardcodes a step list. `status` values (`running`/`generating`/`reviewing`/`done`) are lifecycle labels, not steps. On the web, a kind→UI registry (`apps/web/src/workflows/registry.tsx`) maps each workflow kind to its package-provided `{ NewPane, SelectedPanel }`; `WorkbenchHome` renders the resolved components with no `workflowKind` branching, and the registry throws on an unregistered kind rather than guessing. Each page calls `buildSteps(workflow.currentStep, STEP_LABELS)` to derive the sidebar step list dynamically.

Step *execution* (the per-kind step handlers in `apps/hub/src/routes/workflow.ts`) is not yet extracted into the workflow packages — tracked in CL-1926.

**Two-layer workflows (Resource Enrichment)**: A generic `resource-enrichment` base `WorkflowType` defines the step shape (intake → enrich → review → export) and a domain-agnostic artifact model; specific kinds compose it. The artifacts are: `parsed-resource` (intake snapshot of parsed rows), `selection` (one per row — JSON `{ label, fields: Record<field, string[]>, chosen: Record<field, index> | null }` rendered as a HITL radio picker, content-driven with no domain knowledge), and `csv-export` (the downloadable result). `seo-enrichment` is the first specific kind: xlsx intake, per-row image fetch + multimodal inference producing 5/5/5 SEO variants, CSV export. The enrich step resolves a dedicated tenant-owned inference credential (`google-ai` on `google-genai`), separate from agent chat credentials. The domain logic (parse, image fetch, prompt assembly, per-row `enrichSeoRow`, CSV assembly) lives in `packages/gtm-workflows`; the hub injects only the credential-backed inference call and persists results. The enrich step fans out per row with `Promise.allSettled` in bounded batches, isolating per-row failures as error-state selections so one bad row never aborts the batch. Because Interchange's `agent.send` carries text only, the multimodal turn (text + base64 image) goes through `@intx/inference` `runInference` directly (`runSingleTurnAgentWithImage`).

### Backend (`apps/hub/`)

- **Authentication**: Google OAuth with optional domain allowlisting. Session state stored in secure HTTP-only cookies. CORS origins configurable via trusted origins.
- **Interchange App**: Hub calls `createApp` from Interchange, registering all tenant/principal/grant/agent/instance routes.
- **Workflow Routes**: `POST /workflows`, `GET /workflows/:id`, `POST /workflows/:id/steps`
- **Upload + Download Routes**: `POST /uploads` stores a pre-workflow binary file (xlsx) in an `upload` table (BYTEA, tenant-owned) before any run exists, returning an `uploadId`; `GET /artifacts/:id/download` streams a downloadable artifact (`csv-export` allowlist) as an attachment. `PATCH /workflows/:id/artifacts/:artifactId/selection` writes a reviewer's pick into a `selection` artifact as a new version (row-locked re-read to avoid lost updates).
- **Collateral Generation Route**: `POST /collateral-generation` — accepts `inputArtifactIds[]` and `outputTypes[]`; each output type generates independently in parallel via `@intx/agent`; results stored as artifact rows with `kind = output type`
- **Agent Runtime**: Uses `@intx/agent` (from `interchange/`) with structured JSON outputs
- **Persistence Layer**: PostgreSQL + Drizzle ORM

### Sidecar (`apps/sidecar/`)

- **Agent Orchestration**: Connects to the Interchange hub via WebSocket (`HUB_WS_URL`) and manages the lifecycle of running agents on behalf of the workbench
- **Identity**: Each sidecar has a stable `SIDECAR_ID` (opaque string slug, e.g. `gtm-staging`) and a `SIDECAR_TOKEN` for hub authentication
- **On-disk state**: Maintains per-agent git repositories and key pairs in `SIDECAR_DATA_DIR`. This directory must be backed by a persistent volume in production — loss of this data prevents the sidecar from reconnecting its agents to the hub
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

## Database Schema

Defined in `apps/hub/src/db/schema.ts` using Drizzle ORM.

| Table                            | Key Columns                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact`                       | `id` (UUID PK), `kind` (CollateralType), `sessionId` (UUID FK, nullable), `workflowId` (UUID FK, nullable), `content`, `createdAt`                              |
| `collateral_generation_workflow` | `id` (UUID PK), `userId`, `inputArtifactIds[]`, `outputTypes[]`, `status`, `createdAt`, `updatedAt`                                                             |
| `workbench_user`                 | `id` (UUID PK), `userId`, `personalTenantId`, `workbenchPrincipalId` — provisional cache, pending removal in CL-1245 when scoping moves to tenantId/principalId |

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
- **Parallel generation**: Each collateral output type in a Collateral Generation workflow generates independently in parallel via separate agent calls.
- **Two-mode step execution**: Each generative workflow step runs either in _agent mode_ (routed to a configured tenant agent, which supplies its own inference provider and credentials) or _inline mode_ (the step's own workflow LLM credential). Both modes resolve to a single inference source consumed identically by the step runner; only the source's origin differs.
- **Paste-first intake**: Manual transcript paste remains supported as a secondary path; Oat-driven Granola processing is the primary intake.
- **Human-in-the-loop**: Every major stage requires human approval. No fully automated pipeline.
- **Persistent sessions**: Full workflow state is saved to PostgreSQL. Resumable.

## Known Debt & Forward Direction

- **`pain_point` should be an Artifact, not its own table**: pain points are workflow outputs and belong in the unified `artifact` model (with provenance), not in a dedicated `pain_point` table. The tenancy migration deliberately does not entrench it (it carries no tenant/principal columns and rides `workflow_run`).
- **Avoid per-workflow database structures**: workflow-specific tables do not scale across workflow kinds. `workbench_workflows` is intentionally generic (keyed by a `kind` string + a jsonb `assignments` blob); new workflow kinds must not add bespoke tables.
- **`/me` field rename**: the `/me` response still returns the working (global) tenant id under the legacy field name `personalTenantId`; rename to `tenantId` across hub + web is a pending follow-up.
- **Tool changes require definition edit + relaunch**: there is no PATCH route for live tool updates. To change an agent's tool list, edit the agent definition in admin-ui and relaunch the instance. The `relaunchRunningAgentInstancesForToolUpdate` code path was removed in CL-1536.

---

**API Reference**: See [API.md](./API.md) for detailed endpoint documentation and data type specifications.
