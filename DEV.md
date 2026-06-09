# Development

## Prerequisites

- [Bun](https://bun.sh/) (1.2+)
- Docker (for local PostgreSQL via Compose)
- Git

## Quick Start

```bash
git submodule update --init   # initialize the interchange submodule
bun install                   # install workspace dependencies
docker compose up -d          # start PostgreSQL on localhost:5433
cp .env.example .env          # copy env and fill in values
```

After that, start all services:

```bash
bun run dev
```

This runs the hub (`apps/hub/`) and web (`apps/web/`) dev servers in parallel. The hub is at `http://localhost:4000` and the web UI is at `http://localhost:5174`.

## Environment Setup

Copy the example env file and fill in required values:

```bash
cp .env.example .env
```

The example file contains working dev defaults for most values. Variables you must set:

| Variable               | Required | Description                                             |
| ---------------------- | -------- | ------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | Yes      | 32+ byte secret — generate with `openssl rand -hex 32`  |
| `GOOGLE_CLIENT_ID`     | Yes      | Google OAuth client ID (create in Google Cloud Console) |
| `GOOGLE_CLIENT_SECRET` | Yes      | Google OAuth client secret                              |

Optional credentials for agent tools (leave unset to skip seeding them):

| Variable                     | Tool                                              |
| ---------------------------- | ------------------------------------------------- |
| `OPENAI_COMPATIBLE_API_KEY`  | Myra LLM (and all agents using openai-compatible) |
| `OPENAI_COMPATIBLE_MODEL`    | Model name (default: `gpt-4o`)                    |
| `OPENAI_COMPATIBLE_BASE_URL` | Base URL (default: `https://api.openai.com/v1`)   |
| `ANTHROPIC_API_KEY`          | Anthropic-native inference                        |
| `GRANOLA_API_KEY`            | Oat call ingestion                                |
| `EXA_API_KEY`                | Exa search tool                                   |
| `FIRECRAWL_API_KEY`          | Firecrawl web scrape/crawl tool                   |

### Per-service env files (optional)

For running services individually, per-instance files are also supported:

```bash
cp .env.hub.example .env.hub
cp .env.sidecar.example .env.sidecar
cp .env.migrate.example .env.migrate
```

## Database

PostgreSQL runs on `localhost:5433` via Docker Compose. The migration user (`workbench`) owns the schema; the hub user reads and writes data.

### Apply migrations

```bash
cd apps/hub && bunx drizzle-kit migrate
```

Or from the repo root when the hub is running — migrations also run automatically at hub boot.

### Reset database

```bash
bun run scripts/db-reset.ts
```

Drops and recreates the database, applies all migrations, and optionally seeds the dev superadmin.

## Seeding

### Superadmin

Creates the initial user with owner grants, which lets you log into admin-ui:

```bash
cd apps/hub && bun --env-file=../../.env run bin/seed.ts
```

Reads `SUPERADMIN_EMAIL`, `SUPERADMIN_NAME`, `SUPERADMIN_PASS` from env (or uses defaults from `.env.example`).

### Credentials

Seeds providers and tenant-owned credentials for all configured integrations:

```bash
cd apps/hub && bun run seed:credentials
```

Reads the credential env vars (see table above) and skips any that are unset.

## Running Services Individually

```bash
# Hub only
bun run --filter @workbench/hub dev

# Web only
bun run --filter @workbench/web dev
```

The sidecar is required for agents to be reachable. If you need it locally, start it separately:

```bash
bun run --filter @workbench/sidecar dev
```

## Build Pipeline

Run the full pipeline before opening a PR:

```bash
bun run format    # Prettier auto-fix
bun run lint      # ESLint
bun run check     # tsc -b --noEmit across the full project graph
bun run test      # bun test
```

All four steps must pass. Pre-existing failures must be identified explicitly — never skip a failing step.

## Project Structure

```
apps/
  hub/        Hono API server, DB migrations, agent launch, workflow routes
  web/        React 19 + Vite frontend
  sidecar/    Interchange sidecar — agent lifecycle, WebSocket hub connection
packages/
  agents/     Agent definitions, system prompts, custom directors (@workbench/agents)
  chat/       Transport-agnostic chat UI components
  tools-*/    Tool packages (exa, granola, firecrawl, …)
  shared/     Types shared across the web/API boundary
  workflow-core/  Workflow definitions, step declarations, credential requirements
interchange/  Interchange dependency (do not modify)
scripts/      Operational scripts (create-workbench, db-reset, …)
compose.yml   Local dev infrastructure (PostgreSQL)
```

## Adding a New Tool

1. Copy `packages/tool-template` → `packages/tools-<name>`
2. Implement `create<Name>Tools` and export `*_HUB_TOOLS`
3. Spread `*_HUB_TOOLS` into `KNOWN_TOOLS` in `apps/hub/src/lib/tool-registry.ts`
4. Register the provider + credential in admin-ui or via `seed:credentials`

No sidecar changes required.

## Adding a New Agent

1. Copy `packages/tool-agent` → `packages/agents-<name>` (or add to `packages/agents/`)
2. Fill in `definition.ts` (credential requirements, tool list), `prompt.ts`, and `director.ts`
3. Export from the package index and import in `@workbench/agents`
4. Add to the `AGENT_TEMPLATES` array in `packages/agents/src/index.ts`
5. Re-boot the hub — `seedAgentTemplates` is idempotent and picks up the new definition

## Interchange

Interchange is the agent runtime, identity layer, and credential resolver this product runs on. Read `interchange/docs/` before touching anything in the auth, credential, agent launch, or session domain. Never modify `interchange/` unless explicitly debugging a genuine upstream bug.

See `AGENTS.md` § Interchange for the mandatory lookup checklist and the correct credential + launch pattern.
