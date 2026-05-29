# GTM Workbench — Implementation Documentation

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Package manager | Bun | 1.2+ |
| Frontend | React | 19 |
| Frontend build | Vite | 8 |
| Styling | Tailwind CSS | 4 |
| Animation | Framer Motion | 12 |
| Backend | Hono | 4 |
| ORM | Drizzle ORM | 0.45 |
| Database | PostgreSQL | 18.2-alpine |
| Object storage | MinIO | latest |
| Agent runtime | `@intx/agent` | workspace (via interchange/) |
| Runtime validation | arktype | 2.x |

## TypeScript Configuration

- Extends `tsconfig.base.json` from interchange
- `strict: true`
- `noUncheckedIndexedAccess: true` — check array/object access before using
- `exactOptionalPropertyTypes: true` — optional props cannot be `undefined`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- No `any`, no `as` type assertions. Use `unknown` and narrow.

## File Organization

- **Applications**: `apps/web/`, `apps/api/`
- **Shared libraries**: `packages/*`
- **Examples**: `examples/*` (reference consumers, not throwaway)
- No standalone TypeScript files in repository root

## Naming Conventions

- **Files**: Lowercase, hyphens for multi-word (`pain-point.ts`, `session-service.ts`)
- **Factory functions**: `create*` prefix (`createSessionService`, `createPipeline`)
- **Predicates**: `is*` prefix (`isValidPainPoint`)
- **Retrieval**: `get*` prefix (`getSessionById`)
- **Handlers**: `handle*` prefix (`handleAnalyze`)
- **Variables**: `camelCase` for regular, `SCREAMING_SNAKE_CASE` for constants

## API Surface

### Pipeline Routes

| Method | Route | Input | Output |
|--------|-------|-------|--------|
| `POST` | `/analyze` | `{ transcript: string }` | `{ sessionId, painPoints[], status }` |
| `POST` | `/generate` | `{ sessionId, painPointIds[] }` | `{ collateral[], status }` |
| `POST` | `/improve` | `{ collateralId, feedback: string }` | `{ collateral, status }` |

### Health

| Method | Route | Output |
|--------|-------|--------|
| `GET` | `/health` | `{ status: "ok", service: string }` |

## Database Schema

### Transcripts

- `id` (UUID, primary key)
- `content` (text)
- `source` (enum: paste, granola)
- `createdAt` (timestamp)

### Sessions

- `id` (UUID, primary key)
- `transcriptId` (UUID, foreign key)
- `status` (enum: analyzing, reviewing, generating, improving, exporting, done)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)

### Pain Points

- `id` (UUID, primary key)
- `sessionId` (UUID, foreign key)
- `severity` (enum: low, medium, high, critical)
- `context` (text)
- `quote` (text)
- `selected` (boolean, default false)
- `createdAt` (timestamp)

### Collateral

- `id` (UUID, primary key)
- `painPointId` (UUID, foreign key)
- `type` (enum: email, linkedin, one-pager, battlecard)
- `title` (text)
- `body` (text)
- `status` (enum: draft, approved, rejected)
- `version` (integer, default 1)
- `createdAt` (timestamp)
- `updatedAt` (timestamp)

### Collateral Versions

- `id` (UUID, primary key)
- `collateralId` (UUID, foreign key)
- `title` (text)
- `body` (text)
- `version` (integer)
- `createdAt` (timestamp)

## Local Development

### Infrastructure

```bash
docker compose up -d
```

Services:
- PostgreSQL on `localhost:5433`
- MinIO on `localhost:9000` (API) and `localhost:9001` (console)

### Environment

```bash
cp env.workbench.example .env.workbench
# Edit optional values
```

### Running

```bash
# Terminal 1 — API
bun run --filter @gtm/api dev

# Terminal 2 — Web
bun run --filter @gtm/web dev
```

## Build Pipeline

```bash
bun run format    # Prettier
bun run lint      # ESLint + docs freshness
bun run check     # tsc -b --noEmit
bun run test      # bun test
```

Or via `make all` if Makefile is available.

## Agent Pipeline

Uses `@intx/agent` from `interchange/` with structured JSON outputs.

1. **Analyze**: Agent reads transcript, returns structured pain points
2. **Generate**: Agent takes pain points, returns structured collateral per point
3. **Improve**: Agent takes feedback + existing collateral, returns improved version

All agent outputs are runtime-validated with `arktype` before persistence.
