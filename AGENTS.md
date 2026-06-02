# AGENTS.md

## Session Start

1. Read this file and `CONVENTIONS.md` (or `/.agents/skills/style/SKILL.md`)
2. Scan `/.agents/skills/` for local project skills
3. Do not proceed with user requests until these steps are complete

## Project

**GTM Workbench** (Interchange) is a HITL tool that turns sales call transcripts into publishable collateral. The agent handles analysis and first drafts; the human handles curation, approval, and refinement at every stage.

### Architecture

- `interchange/` — Dependency, not our application. Do not modify unless explicitly asked.
- `apps/web/` — React 19 + Vite 8 + Tailwind CSS + Framer Motion. Human-facing UI.
- `apps/api/` — Hono + TypeScript. Backend runtime, pipeline, and persistence.
- `packages/` — Shared types, utilities, and schema that cross the web/API boundary.
- `compose.yml` — PostgreSQL for local development.
- Root is the monorepo. `interchange/` is mounted alongside it.

### Stack

- Package manager: Bun (1.2+)
- Frontend: React, Vite, Tailwind CSS, Framer Motion
- Backend: Hono, TypeScript, Drizzle ORM
- Agent runtime: `@intx/agent` (from `interchange/`)
- Persistence: PostgreSQL (port 5433 in compose)

- Shared types: `packages/workbench-shared` or equivalent

## Version Validation

When using versioned third-party software (Docker images, npm packages, system tools), **always validate you are using the latest stable version** unless explicitly specified otherwise.

- Check the latest version on the official registry or website before pinning
- Update docs and configuration files if the version is outdated
- If a version is intentionally held back, document the reason in the commit or PR

## Code Reuse

Do not reimplement functionality that already exists in the codebase. Before writing new code:

1. Search for existing implementations that could serve the same purpose
2. If similar functionality exists, prefer refactoring it to meet the new requirements
3. Look for unexported functions in other packages that could be promoted to a shared location
4. Check `interchange/` for patterns, utilities, and types that can be reused

## Configuration

Do not modify configuration files (e.g. eslint, prettier, tsconfig, package.json) unless explicitly asked.

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

   The healthcheck waits for PostgreSQL to be ready.

2. Install dependencies:

   ```bash
   bun install
   ```

3. Configure environment:

   ```bash
   cp .env.workbench.example .env.workbench
   # Edit .env.workbench and fill in optional values
   ```

4. Initialize the database:
   ```bash
   bun run db:setup
   ```
   This script waits for Postgres, creates the database if needed, and runs all migrations (Interchange + custom).

## Development Workflow

**Run everything at once from the root:**

```bash
bun run dev
```

This starts API (port 4000) and Web (port 5174) in parallel using `bun --parallel`.

**Or individually:**

- API: `bun run --filter @gtm/api dev`
- Web: `bun run --filter @gtm/web dev`

**Service locations:**

- Web: `http://localhost:5174` (proxies `/api` to `http://localhost:4000`)
- API: `http://localhost:4000`
- PostgreSQL: `localhost:5433`

**Reset the database:**

```bash
bun run db:reset
bun run db:setup
```

## Workflow API Surface

Implemented in `apps/api` as a unified step-based workflow engine.

| Method | Route                  | Description                                                |
| ------ | ---------------------- | ---------------------------------------------------------- |
| `POST` | `/workflows`           | Create a new workflow (intake transcript)                  |
| `GET`  | `/workflows/:id`       | Get workflow state and history                             |
| `POST` | `/workflows/:id/steps` | Execute a workflow step (analyze, review, improve, export) |

## Prototype Stages

1. **Call Selection** — Paste transcript or pick from Granola API
2. **Live Analysis** — Extract pain points, review and select
3. **Collateral Review** — Card-by-card approval/rejection
4. **Improvement** — Per-item feedback and regeneration
5. **Final Export** — Copy, download, or deliver assembled collateral
6. **Session Dashboard** — Resume prior sessions

## Environment Variables

Required in `.env` (copy from `.env.example`):

| Variable                     | Default                                                                | Purpose                                   |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL`               | `postgres://workbench:workbench-dev-password@localhost:5433/workbench` | Postgres connection string                |
| `PORT`                       | `4000`                                                                 | API server port                           |
| `BETTER_AUTH_SECRET`         | —                                                                      | Required. Auth signing secret             |
| `BETTER_AUTH_BASE_URL`       | `http://localhost:4000`                                                | Required. Public URL of the API           |
| `SUPPORTED_CORS_ORIGINS`     | `http://localhost:5174`                                                | Required in production. Comma-separated   |
| `OPENAI_COMPATIBLE_API_KEY`  | —                                                                      | Required. LLM API key                     |
| `OPENAI_COMPATIBLE_BASE_URL` | `https://api.openai.com/v1`                                            | Optional. LLM endpoint                    |
| `OPENAI_COMPATIBLE_MODEL`    | `gpt-4o-mini`                                                          | Required. Model name                      |
| `VITE_API_BASE_URL`          | `http://localhost:4000`                                                | Build-time. Public URL of the API for web |
| `GRANOLA_API_KEY`            | —                                                                      | Optional. Granola integration             |
| `GOOGLE_CLIENT_ID`           | —                                                                      | Optional. Google OAuth                    |
| `GOOGLE_CLIENT_SECRET`       | —                                                                      | Optional. Google OAuth                    |
| `GOOGLE_ALLOWED_DOMAINS`     | —                                                                      | Optional. Comma-separated allowed domains |

## Railway Deployment

Configuration lives in `railway.toml` at the repo root. Do not change these without understanding the implications:

- **Builder:** `railpack` (Railway's current default — not nixpacks, which is legacy)
- **Build command:** `bun install && bun run --filter @gtm/api build`
- **Pre-deploy command:** `bun run scripts/db-setup.ts` — runs forward-only migrations before each deploy; safe to re-run (idempotent)
- **Start command:** `bun run --filter @gtm/api start`

The pre-deploy command calls `scripts/db-setup.ts` directly (not via `bun run db:setup`) because the root `db:setup` script passes `--env-file=.env`, which does not exist on Railway — env vars are injected by the platform.

Required environment variables to set in the Railway dashboard before deploying:

- `DATABASE_URL` — provided by Railway's Postgres plugin
- `BETTER_AUTH_SECRET` — generate a random secret
- `BETTER_AUTH_BASE_URL` — public URL of the deployed API service
- `SUPPORTED_CORS_ORIGINS` — public URL of the deployed web service
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_MODEL`

`VITE_API_BASE_URL` must be set on the **web** service (build-time variable), pointing to the deployed API URL.

## Code Style

- TypeScript strict mode enabled
- Bun as runtime and package manager
- No `console.log` in production code; use structured logging
- Keep `interchange/` untouched

## Environment and Configuration

- **No fallbacks for required environment variables.** If a variable is required, use `requireEnv()` (or equivalent) and fail loudly at startup. Do not use `|| 'default'` or `?? 'default'` to paper over a missing value.
- All environment validation lives in `apps/api/src/config.ts`. Add new variables there, not inline in `index.ts` or elsewhere.
- Optional variables (e.g. `GOOGLE_CLIENT_ID`) must be explicitly handled as `string | undefined` — never coerced to empty string silently.
- The only acceptable default is for variables where the default is part of the API contract (e.g. `VITE_API_BASE_URL` defaults to `''` for same-origin relative URLs).

## Dependency Injection vs. Direct Imports

Use one pattern consistently — do not mix them.

**Inject stateful resources** (database connections, HTTP clients, queues). These may have multiple instances in future (e.g. read/write replicas) and need to be controlled in tests.

```ts
// correct
export function createWorkflowRouter(db: Database): Hono { ... }
```

**Import stateless singletons directly** (config, loggers, constants). They have one instance, never need to be swapped, and injecting them just adds boilerplate.

```ts
// correct
import { loadConfig } from '../config';
const { granola } = loadConfig();

// wrong — config is not a stateful resource
export function createWorkflowRouter(db: Database, config: Config): Hono { ... }
```

**In tests**, mock stateless modules at the module boundary (`mock.module(...)`) rather than injecting fakes through function arguments.

## Constraints

- Do **not** make CRM sync (Attio) a dependency for v1
- Do **not** build fully automated pipeline
- Paste-first intake is the primary path; Granola API is optional secondary
- Session state must be persisted and resumable
- Auth should be lightweight for the prototype (demo gate or minimal)
- Export targets can include markdown, clipboard, email draft, Slack, Typefully

## Interchange Infrastructure

**Do not circumvent or reinvent interchange utilities.** The `interchange/` dependency provides proven infrastructure for agent runtime, inference, logging, and persistence. Use it.

### LLM Inference: Use `@intx/agent`, Never Direct API Calls

**Rule:** Any LLM inference (extraction, generation, analysis, refinement) must use `@intx/agent` from `interchange/packages/agent`. Never make direct `fetch()` calls to LLM endpoints.

**Why:**

- Direct calls bypass config management, error handling, and logging built into the agent runtime
- Environment variable handling (API key, model, base URL) is inconsistent and error-prone
- Failed requests provide no visibility into what URL was called or what the error response contained
- The agent runtime handles inference source management, context persistence, and retry policy centrally

**How to use `@intx/agent` for LLM inference:**

1. **Create an inference source** from environment variables:

   ```typescript
   const source: InferenceSource = {
     id: `task-${taskId}`,
     provider: 'openai', // or 'anthropic', 'google-genai'
     baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1',
     apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
     model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
   };
   ```

2. **Create an agent with minimal config** (use temp directory for context):

   ```typescript
   const { tmpdir } = await import('node:os');
   const { join } = await import('node:path');
   const { randomUUID } = await import('node:crypto');

   const contextDir = join(tmpdir(), `task-${randomUUID()}`);
   const agent = await createAgent({
     contextDir, // Auto-managed isogit store, cleaned up after close()
     sources: [source],
     defaultSource: source.id,
     systemPrompt: 'Your system instructions here.',
     tools: [],
     closeTimeoutMs: 1000,
   });
   ```

3. **Send your prompt and get structured response:**

   ```typescript
   const result = await agent.send(userMessage);
   await agent.close();

   // result.reply contains the LLM response as a string
   const parsed = JSON.parse(result.reply); // or text parsing
   ```

**Pattern:** For single-call inference (extraction, analysis), create an agent, send one message, close immediately. The temp contextDir is automatically cleaned up. No manual persistence needed unless the inference is part of a multi-turn conversation.

**See also:** Review `interchange/packages/agent/` source and tests for advanced patterns (tools, streaming, multi-turn conversations).

## Personality

- Do not use emojis in code, documentation, or messages (unless explicitly requested)
- Act professionally
- Use plain language. No jargon you haven't earned
- Be concise
