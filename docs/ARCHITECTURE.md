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

### Signup Provisioning

On signup, the hub:

1. Creates a personal Interchange tenant for the user (slug: `user-{userId}`)
2. Assigns the user the `owner` role on their personal tenant
3. Creates a principal for the user in the shared GTM Workbench tenant (member role)
4. Seeds a cross-tenant deliver grant on the personal tenant's `owner` role, enabling Myra to deliver mail to workbench agents

### Agent Architecture

| Agent                     | Tenant                             | Role                                                              |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| **Myra** (personal agent) | User's personal Interchange tenant | Chief of Staff / Executive Assistant for the user                 |
| **Oat** (Granola agent)   | Shared GTM Workbench tenant        | Continuously processes Granola calls into call document artifacts |

Both Myra and Oat use custom directors wrapping `createDefaultDirector` to filter inbound senders before inference.

### Credential and Grant Model

Credentials and grants follow Interchange's model exactly. The workbench does not define its own credential abstraction.

**Credentials** are stored in Interchange's `credential` table. Every credential belongs to a tenant and has a `providerId` (pointing to a `provider` row naming the integration, e.g. `"openai-compatible"`). Credentials intended for agent resolution are stored **tenant-owned** — `principalId: null`. This is required for `source: 'tenant'` resolution to work.

**Agent credential requirements**: Each agent definition declares `credentialRequirements` — a list of `{ providerName, source, name? }` entries describing what the agent needs at launch. Interchange resolves these automatically at launch time by walking the tenant hierarchy. The workbench never passes credential IDs to the session launch call.

**Credential resolution at launch time**: Interchange's `resolveCredentialRequirement` walks up the tenant ancestor chain looking for a credential matching `providerName + source` (and optionally `name`). The workbench relies entirely on this resolver — it never builds inference sources manually or passes credential IDs through the launch call.

**Myra's credential requirement**: `{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }`. The user saves a credential named `'Myra LLM'` in their personal tenant during onboarding. Interchange finds it at launch time.

**Onboarding flow**: The frontend saves the credential via `POST /v1/tenants/:tenantId/credentials`, then calls `POST /v1/instances/:instanceId/sessions` with no credential IDs. The hub launches the session; Interchange resolves the credential from the tenant.

**Grants** (manage access, not resolution): The hub writes a `grant` row giving the creating principal manage access to the credential record (`resource: credential:{id}`, `origin: creator`). This grant enables the Settings UI to delete/update the credential. It is separate from resolution — Interchange resolves credentials from the tenant, not from grants to instance principals.

### Credential Encryption at Rest

Credential secrets written by the hub layer are encrypted before storage using AES-256-GCM with per-tenant key derivation. Interchange's `credential` table stores the ciphertext; no `@intx/*` package is modified.

**Encryption boundary**: Only the hub layer encrypts and decrypts. Interchange is unaware of the wrapping — it sees opaque `secret` values. The hub decrypts before passing secrets to agents or making comparisons.

**`enc:` prefix convention**: Encrypted values are stored as `enc:vN:<base64(iv+tag+ciphertext)>`. The version number (`N`) identifies which key was used. Rows without the prefix are treated as legacy plaintext and are re-encrypted on next write.

**Key rotation**: The hub supports multiple simultaneous key versions. All registered versions can decrypt; the highest-numbered version encrypts new values. Rotation is handled by adding a new version to `CREDENTIAL_ENCRYPTION_KEYS` without downtime.

**`@workbench/hub-crypto`**: The encryption primitives (`parseEncryptionKeys`, `encryptSecret`, `decryptSecret`) live in a standalone package with no workbench-specific dependencies. Any Interchange-based hub can adopt the same encryption layer by adding this package and wiring `CREDENTIAL_ENCRYPTION_KEYS` at startup.

## Component Diagram

### Frontend (`apps/web/`)

- **Dashboard**: Entry point. New workflow, resume session, artifact browser.
- **Collateral Generation**: Select input artifacts and output types, trigger generation.
- **Artifact Review**: Card-by-card review, approval, inline improvement.
- **Final Export**: Assembled collateral with copy/export actions.
- **Chat**: Chat with Myra or workspace agents via `@workbench/chat` components.

**State Management**: The frontend uses TanStack Query for all server state. Each stage page queries the workflow endpoint (`GET /workflows/:id`) and mutates via step endpoints (`POST /workflows/:id/steps`). No local session state is held in React context.

**Step Derivation**: The workflow state includes a derived `currentStep` field that maps workflow `status` to the active step name. Mapping is defined in `apps/hub/src/routes/workflow.ts:deriveCurrentStep()`. Each page calls `buildSteps(workflow.currentStep, STEP_LABELS)` to derive the sidebar step list dynamically.

### Backend (`apps/hub/`)

- **Authentication**: Google OAuth with optional domain allowlisting. Session state stored in secure HTTP-only cookies. CORS origins configurable via trusted origins.
- **Interchange App**: Hub calls `createApp` from Interchange, registering all tenant/principal/grant/agent/instance routes.
- **Workflow Routes**: `POST /workflows`, `GET /workflows/:id`, `POST /workflows/:id/steps`
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

## Data Flow

1. **Oat processes Granola calls** → Creates call document artifacts in the `artifact` table
2. **User triggers Collateral Generation** → `POST /collateral-generation` with `inputArtifactIds[]` and `outputTypes[]`
3. **Parallel generation** → Each output type generates independently via `@intx/agent`
4. **Artifacts stored** → Results saved as `artifact` rows with `kind = output type` and `workflowId` FK
5. **Review/Export** → User reviews artifacts, copies or downloads final output

## Terminology

- **Workspace**: The user-facing organizational unit in GTM Workbench. Every user belongs to one workspace. Use "workspace" in UI copy.
- **Tenant**: The Interchange concept that a workspace maps to 1:1. Use "tenant" in backend/API code, "workspace" in UI and product copy.
- **Personal Tenant**: Each user also gets a personal Interchange tenant (slug: `user-{userId}`) where their personal agent Myra lives.
- **Source**: Input material selected for a job, such as a call document, uploaded file, brain/context file, URL, or prior artifact reused as input.
- **Workflow**: A reusable recipe or definition. Workbench owns the product-facing offering; Interchange owns deployable workflow execution.
- **Job**: One execution/run of a workflow against selected sources and options. Jobs are what users resume, review, and complete.
- **Review Gate**: A human decision point in a job, such as selecting input artifacts, confirming findings, approving collateral, or confirming delivery.
- **Artifact**: An output produced or curated by a job or agent. Artifacts can later be selected as sources for new jobs, but remain outputs with provenance.
- **Hook**: Optional delivery action after review, such as copy/export, draft email, schedule social post, or webhook/custom action.

## Design Decisions

- **Interchange as the foundation**: The hub deploys `createApp` from Interchange rather than building its own tenant/identity/agent infrastructure.
- **Per-user personal tenants**: Each user gets their own Interchange tenant for Myra, enabling personal-agent isolation and cross-tenant grant semantics.
- **Artifact-centric model**: All outputs — from agents and workflows — are stored as `artifact` rows with provenance. Artifacts can be reused as inputs.
- **Parallel generation**: Each collateral output type in a Collateral Generation workflow generates independently in parallel via separate agent calls.
- **Paste-first intake**: Manual transcript paste remains supported as a secondary path; Oat-driven Granola processing is the primary intake.
- **Human-in-the-loop**: Every major stage requires human approval. No fully automated pipeline.
- **Persistent sessions**: Full workflow state is saved to PostgreSQL. Resumable.

---

**API Reference**: See [API.md](./API.md) for detailed endpoint documentation and data type specifications.
