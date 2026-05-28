# AGENTS.md

## Session Initialization

At the start of every session, before doing any other work:

1. Read this file (`AGENTS.md`) and `CONVENTIONS.md` (or `/.agents/skills/style/SKILL.md` if conventions are not yet extracted)
2. Scan `/.agents/skills/` for local project skills
3. Do not proceed with user requests until these steps are complete

## Project Overview

**GTM Workbench** (codename: Interchange) is a human-in-the-loop (HITL) tool that turns sales call transcripts into polished, publishable collateral. The agent analyzes transcripts, extracts pain points, and generates targeted collateral. The user reviews, approves, rejects, and refines at every stage.

This is **intentionally not** a fully automated pipeline. The agent handles analysis and first-draft generation; the human handles curation, approval, and refinement.

### Parent Context

- **Workbench Prototype** — Defines goals, stages, acceptance checklist, and recommended stack.
- **Scaffold Monorepo** — Defines the workspace structure, apps, and local dev environment.

### Architecture

- `interchange/` — **Dependency, not our application**. Existing Hono/websocket/agent infrastructure. Treated as a git submodule or vendored dependency. Do not modify its internals unless explicitly asked.
- `apps/web/` — React 19 + Vite + Tailwind CSS + Framer Motion. Human-facing workbench UI.
- `apps/api/` — Hono + TypeScript. Backend runtime, pipeline, and persistence.
- `packages/` — Shared types, utilities, and schema that cross the web/API boundary.
- `compose.yml` — PostgreSQL + MinIO for local development.
- Root is the monorepo. `interchange/` is mounted alongside it.

### Stack

- **Package manager**: Bun (1.2+)
- **Frontend**: React, Vite, Tailwind CSS, Framer Motion
- **Backend**: Hono, TypeScript, Drizzle ORM
- **Agent runtime**: `@intx/agent` (from `interchange/`)
- **Persistence**: PostgreSQL (port 5433 in compose)
- **Object storage**: MinIO (port 9000/9001 in compose)
- **Shared types**: `packages/workbench-shared` or equivalent

## Code Reuse and Refactoring

Do not reimplement functionality that already exists in the codebase. Before writing new code:

1. Search for existing implementations that could serve the same purpose
2. If similar functionality exists, prefer refactoring it to meet the new requirements
3. Look for unexported functions in other packages that could be promoted to a shared location
4. Check `interchange/` for patterns, utilities, and types that can be reused

When you detect that a refactor might be necessary, prompt the user with specific options and allow them to provide their own answer if none fit.

## Configuration

Do not modify configuration files (e.g. eslint, prettier, tsconfig, package.json) unless explicitly asked. Focus on writing working software, not changing the conventions that are being used.

## Commit Process

Follow this workflow for every change. Each step is a separate, focused commit.

### Step 1: Write tests first

```
Write or update tests for the change you are about to make
→ Run tests to confirm they fail (red)
→ Commit with message: "Add test for <feature/fix>"
```

### Step 2: Make the change

```
Implement the minimal change to make the tests pass
→ Run tests to confirm they pass (green)
→ Run the full build pipeline (format, lint, check, test)
→ Commit with message: "<feature/fix>: <what changed>"
```

### Step 3: Update documentation

```
Invoke the scribe skill (/.agents/skills/scribe/SKILL.md) to update PRODUCT.md, ARCHITECTURE.md, or IMPLEMENTATION.md as needed
→ Commit docs separately with message: "Update docs: <what changed>"
```

### Commit discipline

- One logical change per commit
- Commit messages should be small, precise, and easily auditable
- Focus on one thing at a time
- Always stop and provide the user with a clear commit message and suggestion to commit
- Do not auto-commit unless the user explicitly overrides and says the agent can auto-commit

### Example workflow

```
# User asks for a feature
1. Write tests for the feature → commit: "Add test for pain point severity enum"
2. Implement the feature → commit: "Add severity enum to pain point extraction"
3. Run scribe → commit: "Update docs: add severity enum to ARCHITECTURE.md"
```

## Build Requirements

You must run the full build pipeline before declaring any task complete:

```bash
# Run all verification: format, lint, type-check, test
bun run format
bun run lint
bun run check
bun run test
```

Or via the Makefile if one is available:
```bash
make all
```

- `bun run check` validates the entire TypeScript project graph via `tsc -b`
- Individual package builds do not guarantee the full tree will build
- Type exports and imports may not be available until the full tree is built
- Tests may fail if dependent packages are not rebuilt

If the build fails, report the failure and identify the cause. If the failure is pre-existing and unrelated to your changes, say so explicitly and let the user decide how to proceed. Never silently skip a failing step or substitute a partial build.

## Setup Commands

1. Start infrastructure:
   ```bash
   docker compose up -d
   ```
2. Install dependencies:
   ```bash
   bun install
   ```
3. Configure environment:
   ```bash
   cp env.workbench.example .env.workbench
   # Edit .env.workbench and fill in optional values
   ```

## Development Workflow

- **Run API** (port 4000):
  ```bash
  bun run --filter @gtm/api dev
  ```
- **Run Web** (port 5174):
  ```bash
  bun run --filter @gtm/web dev
  ```
- Web Vite config proxies `/api` to `http://localhost:4000`.
- PostgreSQL runs on `localhost:5433` (mapped from 5432 to avoid collision with any existing `interchange` services).
- MinIO console is at `http://localhost:9001` (login: `minioadmin` / `minioadmin-password`).

## Pipeline API Surface

Implemented in `apps/api`. Placeholder routes are acceptable until the backend pipeline is built.

| Method | Route | Description |
|--------|-------|-------------|
| `POST` | `/analyze` | Extract pain points with severity, context, and quote |
| `POST` | `/generate` | Create collateral per selected pain point |
| `POST` | `/improve` | Regenerate a specific collateral item from feedback |

## Prototype Stages

1. **Call Selection** — Paste transcript or pick from Granola API
2. **Live Analysis** — Extract pain points, review and select
3. **Collateral Review** — Card-by-card approval/rejection
4. **Improvement** — Per-item feedback and regeneration
5. **Final Export** — Copy, download, or deliver assembled collateral
6. **Session Dashboard** — Resume prior sessions

## Environment Variables

Required in `.env.workbench`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DB_HOST` | `localhost` | Postgres host |
| `DB_PORT` | `5433` | Postgres port |
| `DB_NAME` | `workbench` | Database name |
| `DB_USER` | `workbench` | Database user |
| `DB_PASSWORD` | `workbench-dev-password` | Database password |
| `S3_ENDPOINT` | `127.0.0.1:9000` | MinIO endpoint |
| `S3_ACCESS_KEY` | `minioadmin` | MinIO access key |
| `S3_SECRET_KEY` | `minioadmin-password` | MinIO secret key |
| `S3_BUCKET` | `gtm-workbench-exports` | Default bucket |
| `S3_FORCE_PATH_STYLE` | `true` | MinIO compatibility |
| `PORT` | `4000` | API server port |
| `GRANOLA_API_KEY` | — | Optional Granola API key |
| `GRANOLA_API_URL` | — | Optional Granola API URL |
| `OPENAI_API_KEY` | — | Optional LLM key |
| `OPENAI_BASE_URL` | — | Optional LLM endpoint |
| `OPENAI_MODEL` | — | Optional model name |

## Code Style

- TypeScript strict mode enabled
- Bun as runtime and package manager
- No `console.log` in production code; use structured logging
- Keep `interchange/` untouched — it is a dependency

## Constraints

- Do **not** make CRM sync (Attio) a dependency for v1
- Do **not** build fully automated pipeline — preserve human approval at every stage
- Paste-first intake is the primary path; Granola API is optional secondary
- Session state must be persisted and resumable
- Auth should be lightweight for the prototype (demo gate or minimal)
- Export targets can include markdown, clipboard, email draft, Slack, Typefully — but do not block prototype on every integration

## Personality

- Do not use emojis in code or documentation
- Act professionally
- Use plain language. No jargon you haven't earned
- Be concise — every line earns its place
