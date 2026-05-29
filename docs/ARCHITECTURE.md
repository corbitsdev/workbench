# GTM Workbench — Architecture Documentation

## System Overview

The workbench is a monorepo with two runtime applications and shared packages.

```
Root monorepo
├── apps/web/          → React frontend (user-facing)
├── apps/api/          → Hono backend (pipeline, persistence, API)
├── packages/          → Shared types, utilities, schema
├── interchange/       → Dependency (agent runtime, infrastructure)
└── compose.yml        → Local dev infrastructure (PostgreSQL + MinIO)
```

## Component Diagram

### Frontend (`apps/web/`)

- **Call Selection**: Single-panel input. Transcript paste or recent-call picker.
- **Live Analysis**: Two-panel layout. Left = transcript (collapsible sidebar), Right = live agent analysis with pain point summary.
- **Collateral Review**: Sidebar + main window. Card-stack review pattern per pain point.
- **Improvement**: Approved pieces with per-item feedback and regeneration.
- **Final Export**: Full-screen panel. Assembled collateral with copy/export actions.
- **Dashboard**: Entry point. New call, resume session, processed calls view.

### Backend (`apps/api/`)

- **Pipeline Routes**: `POST /analyze`, `POST /generate`, `POST /improve`
- **Session Service**: Orchestrates stage transitions, persists state
- **Agent Runtime**: Uses `@intx/agent` (from `interchange/`) with structured JSON outputs
- **Persistence Layer**: PostgreSQL + Drizzle ORM for session state
- **Object Storage**: MinIO / S3-compatible for large export artifacts

### Database Schema

Defined in `apps/api/src/db/schema.ts` using Drizzle ORM.

| Table | Key Columns |
|-------|-------------|
| `transcript` | `id` (UUID PK), `content` (text), `source` (enum: paste, granola), `createdAt` |
| `workbench_session` | `id` (UUID PK), `transcriptId` (UUID FK), `status` (enum: analyzing, reviewing, generating, improving, exporting, done), `createdAt`, `updatedAt` |
| `pain_point` | `id` (UUID PK), `sessionId` (UUID FK), `severity` (enum: low, medium, high, critical), `context`, `quote`, `selected` (boolean), `createdAt` |
| `collateral_item` | `id` (UUID PK), `painPointId` (UUID FK), `type` (enum: email, linkedin, one-pager, battlecard), `title`, `body`, `status` (enum: draft, approved, rejected), `version`, `createdAt`, `updatedAt` |
| `collateral_version` | `id` (UUID PK), `collateralId` (UUID FK), `title`, `body`, `version`, `createdAt` |

### Shared Packages (`packages/`)

- **workbench-shared**: Types crossing the web/API boundary (PainPoint, CollateralItem, TranscriptInput, WorkbenchSession)
- **Additional packages**: Reuse patterns from `interchange/` where possible

## Data Flow

1. **Transcript submitted** → API persists session, begins analysis
2. **Analysis** → Agent extracts pain points → API saves to PostgreSQL
3. **User selects pain points** → Frontend sends selection → API updates session
4. **Generation** → Agent creates collateral per pain point → API saves to PostgreSQL
5. **Review/Improvement** → Frontend sends feedback → API archives old version, saves new
6. **Export** → API assembles final output, uploads to MinIO if large, returns reference

## Design Decisions

- **Separation from interchange**: `interchange/` is a dependency. Our apps live at the root.
- **Paste-first**: Intake is intentionally lightweight. CRM sync is v2.
- **Human-in-the-loop**: Every major stage requires human approval. No fully automated pipeline.
- **Persistent sessions**: Full session state is saved to PostgreSQL. Resumable.
- **S3 for exports**: Large artifacts stored in MinIO, with references in the database.
