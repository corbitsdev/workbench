# GTM Workbench — Architecture Documentation

## System Overview

The workbench is a monorepo with two runtime applications and shared packages.

```
Root monorepo
├── apps/web/          → React frontend (user-facing)
├── apps/hub/          → Hono backend (pipeline, persistence, API)
├── apps/sidecar/      → Interchange sidecar (agent lifecycle, hub connection)
├── packages/          → Shared types, utilities, schema
├── interchange/       → Dependency (agent runtime, infrastructure)
└── compose.yml        → Local dev infrastructure (PostgreSQL)
```

The current shipped workflow is transcript-to-artifact, but the product model is
expanding toward a source-to-artifact workbench contract: users select Sources,
launch outcome-oriented Jobs, pass through Review Gates, approve Artifacts, and
optionally run delivery Hooks. See
[SOURCE_TO_ARTIFACT.md](./SOURCE_TO_ARTIFACT.md) for the canonical domain terms
and the boundary between Workbench presentation and Interchange workflow
execution.

## Component Diagram

### Frontend (`apps/web/`)

- **Call Selection**: Single-panel input. Transcript paste or recent-call picker.
- **Live Analysis**: Two-panel layout. Left = transcript (collapsible sidebar), Right = live agent analysis with pain point summary. Fetches real pain points via TanStack Query.
- **Collateral Review**: Sidebar + main window. Card-stack review pattern per pain point. Reads collateral from the backend session state.
- **Improvement**: Approved pieces with per-item feedback and regeneration. Calls `/improve` per item with feedback.
- **Final Export**: Full-screen panel. Assembled collateral with copy/export actions.
- **Dashboard**: Entry point. New call, resume session, processed calls view.

**State Management**: The frontend uses TanStack Query for all server state. Each stage page queries the session endpoint (`GET /workflows/:id`) and mutates via step endpoints (`POST /workflows/:id/steps`). No local session state is held in React context.

**Step Derivation**: The workflow state includes a derived `currentStep` field that maps the workflow `status` to the active step name (`intake`, `analyze`, `generate`, `improve`, `export`). Mapping is defined in `apps/hub/src/routes/workflow.ts:deriveCurrentStep()`. Each page calls `buildSteps(workflow.currentStep, STEP_LABELS)` to derive the sidebar step list dynamically. This ensures:

- All pages show consistent step progression
- Step status (completed/current/pending) is always accurate
- No hardcoded STEPS constants per page
- Single source of truth: `workflow.status` → `currentStep` → sidebar UI

### Backend (`apps/hub/`)

- **Authentication**: Google OAuth with optional domain allowlisting. Session state stored in secure HTTP-only cookies. CORS origins configurable via trusted origins.
- **Workflow Routes**: `POST /workflows`, `GET /workflows/:id`, `POST /workflows/:id/steps`
- **Steps**: `analyze`, `generate`, `improve`, `export` — each advances the workflow state machine
- **Pain Point Extraction**: Implemented in `lib/extraction.ts`. Uses OpenAI LLM when configured, falls back to keyword heuristic. Accepts optional feedback to refine prompts.
- **Session Service**: Orchestrates stage transitions, persists state, manages user sessions
- **Agent Runtime**: Uses `@intx/agent` (from `interchange/`) with structured JSON outputs
- **Persistence Layer**: PostgreSQL + Drizzle ORM for session state

### Database Schema

Defined in `apps/hub/src/db/schema.ts` using Drizzle ORM.

| Table                | Key Columns                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transcript`         | `id` (UUID PK), `content` (text), `source` (enum: paste, granola), `createdAt`                                                                                                                   |
| `workbench_session`  | `id` (UUID PK), `transcriptId` (UUID FK), `status` (enum: analyzing, reviewing, generating, improving, exporting, done), `createdAt`, `updatedAt`                                                |
| `pain_point`         | `id` (UUID PK), `sessionId` (UUID FK), `severity` (enum: low, medium, high, critical), `context`, `quote`, `selected` (boolean), `createdAt`                                                     |
| `collateral_item`    | `id` (UUID PK), `painPointId` (UUID FK), `type` (enum: email, linkedin, one-pager, battlecard), `title`, `body`, `status` (enum: draft, approved, rejected), `version`, `createdAt`, `updatedAt` |
| `collateral_version` | `id` (UUID PK), `collateralId` (UUID FK), `title`, `body`, `version`, `createdAt`                                                                                                                |

### Sidecar (`apps/sidecar/`)

- **Agent Orchestration**: Connects to the Interchange hub via WebSocket (`HUB_WS_URL`) and manages the lifecycle of running agents on behalf of the workbench
- **Identity**: Each sidecar has a stable `SIDECAR_ID` (opaque string slug, e.g. `gtm-staging`) and a `SIDECAR_TOKEN` for hub authentication
- **On-disk state**: Maintains per-agent git repositories and key pairs in `SIDECAR_DATA_DIR`. This directory must be backed by a persistent volume in production — loss of this data prevents the sidecar from reconnecting its agents to the hub
- **Hub relationship**: The hub also maintains on-disk state (`HUB_DATA_DIR`) and requires a persistent volume for the same reason. If either side loses state, the sidecar–hub trust relationship must be re-established

### Shared Packages (`packages/`)

- **workbench-shared**: Types crossing the web/API boundary (PainPoint, CollateralItem, TranscriptInput, WorkbenchSession)
- **Additional packages**: Reuse patterns from `interchange/` where possible

## Data Flow

1. **Transcript submitted** → API persists session, begins analysis
2. **Analysis** → Agent extracts pain points → API saves to PostgreSQL
   - **With feedback refinement**: User can optionally provide feedback (e.g., "focus on automation pain"). This feedback is passed to the LLM as a prompt condition, refining which pain points are extracted and their prioritization.
3. **User selects pain points** → Frontend sends selection → API updates session
4. **Generation** → Agent creates collateral per pain point → API saves to PostgreSQL
5. **Review/Improvement** → Frontend sends per-item feedback → API applies feedback (archiving old version, saving new)
6. **Export** → API assembles final output and returns it directly in the response

## Terminology

- **Workspace**: The user-facing organizational unit in GTM Workbench. Every user belongs to one workspace. Always use "workspace" in UI copy.
- **Tenant**: The Interchange concept that a workspace maps to 1:1. Creating a workspace provisions an Interchange tenant. Use "tenant" in backend/API code, "workspace" in UI and product copy.
- **Source**: Input material selected for a job, such as a transcript, markdown document, uploaded file, brain/context file, URL, or prior artifact reused as input.
- **Workflow**: A reusable recipe or definition. Workbench owns the product-facing offering; Interchange owns deployable workflow execution as that runtime lands.
- **Job**: One execution/run of a workflow against selected sources and options. Jobs are what users resume, review, and complete.
- **Review Gate**: A human decision point in a job, such as selecting pain points, confirming findings, approving artifacts, or confirming delivery.
- **Artifact**: An output produced or curated by a job. Artifacts can later be selected as sources for new jobs, but remain outputs with provenance.
- **Hook**: Optional delivery action after review, such as copy/export, draft email, schedule social post, or webhook/custom action.

## Design Decisions

- **Separation from interchange**: `interchange/` is a dependency. Our apps live at the root.
- **Paste-first**: Intake is intentionally lightweight. CRM sync is v2.
- **Human-in-the-loop**: Every major stage requires human approval. No fully automated pipeline.
- **Persistent sessions**: Full session state is saved to PostgreSQL. Resumable.

---

**API Reference**: See [API.md](./API.md) for detailed endpoint documentation and data type specifications.
