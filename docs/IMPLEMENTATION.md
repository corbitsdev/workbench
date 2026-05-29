# GTM Workbench — Implementation Documentation

## Technology Stack

| Layer              | Technology     | Version                      |
| ------------------ | -------------- | ---------------------------- |
| Package manager    | Bun            | 1.2+                         |
| Frontend           | React          | 19                           |
| Frontend build     | Vite           | 8                            |
| Styling            | Tailwind CSS   | 4                            |
| Animation          | Framer Motion  | 12                           |
| State management   | TanStack Query | 5                            |
| Backend            | Hono           | 4                            |
| ORM                | Drizzle ORM    | 0.45                         |
| Database           | PostgreSQL     | 18.2-alpine                  |
| Object storage     | MinIO          | latest                       |
| Agent runtime      | `@intx/agent`  | workspace (via interchange/) |
| Runtime validation | arktype        | 2.x                          |

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

| Method | Route                  | Input                                            | Output                               |
| ------ | ---------------------- | ------------------------------------------------ | ------------------------------------ |
| `POST` | `/workflows`           | `{ transcript, source }`                         | `{ id, status, steps }`              |
| `GET`  | `/workflows/:id`       | —                                                | `{ id, status, currentStep, steps }` |
| `POST` | `/workflows/:id/steps` | `{ step, painPointIds, feedback, collateralId }` | `{ id, status, currentStep, steps }` |
| `GET`  | `/recent-calls`        | —                                                | `{ calls }`                          |

### Health

| Method | Route     | Output                              |
| ------ | --------- | ----------------------------------- |
| `GET`  | `/health` | `{ status: "ok", service: string }` |

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

### Pain Point Extraction

Implemented in `apps/api/src/lib/extraction.ts`:


**LLM Path** (when `OPENAI_API_KEY` is configured):

- **Model**: Configurable via `OPENAI_MODEL` (default: `gpt-4o-mini`)
- **Endpoint**: Configurable via `OPENAI_BASE_URL` (default: `https://api.openai.com/v1`)
- **Format**: JSON response with `response_format: { type: 'json_object' }`
- **Temperature**: 0.3 (deterministic output, not creative)
- **Max tokens**: 2048
- **Prompt structure**:
  - System role: "You are a sales transcript analyst. Extract up to 5 distinct pain points from the transcript."
  - If feedback provided: "The user provided this feedback to refine the analysis: '[feedback]'. Prioritize pain points that match this feedback."
  - User role: Transcript content (truncated to 100k chars to respect token limits)
- **Output validation**: Parsed JSON must contain `painPoints` array with each item having:
  - `severity`: one of `low`, `medium`, `high`, `critical`
  - `context`: summary (truncated to 500 chars)
  - `quote`: exact customer words (truncated to 500 chars)
- **Error handling**: HTTP errors and parse failures throw; errors bubble up to global error handler for observability

**Fallback Path** (no API key or LLM failure):

- **Strategy**: Keyword heuristic on transcript lines
- **Keywords** with mapped severity:
  - High severity: `difficult`, `frustrat*`, `pain`, `generic`, `waste`, `never`, `always`, `every`
  - Medium severity: `problem`, `challenge`, `slow`, `manual`
- **Deduplication**: Extracted points are deduplicated on first 60 chars of context
- **Limit**: Returns up to 5 pain points
- **Selection state**: All extracted points marked `selected: true` by default

### Collateral Generation and Improvement

1. **Generate**: Agent takes selected pain points, returns structured collateral (email, LinkedIn, one-pager, battlecard) per point
2. **Improve**: Agent accepts feedback + existing collateral, returns improved version with applied changes (shortening, tone adjustments, etc.)

All agent outputs are runtime-validated with `arktype` before persistence.

## UI Components

### Sidebar Navigation (`StepSidebar`)

Located in `apps/web/src/components/StepSidebar.tsx`.

**Behavior:**

- Displays 5 workflow steps with numeric indicators (or checkmarks for completed steps)
- Current step highlighted with white background and shadow
- Completed steps show green checkmark instead of number
- Pending steps dimmed (opacity 50%)

**Collapse/Expand:**

- Toggle button in header (chevron icon that rotates)
- Collapsed width: 64px; expanded width: 224px
- Spring transition: `stiffness: 300, damping: 30`
- Labels and source info fade out via `AnimatePresence` when collapsed
- Selection count displayed at bottom when expanded

**Dynamic Step Derivation:**

- Steps are not hardcoded per page. Instead, each page calls `buildSteps(workflow.currentStep, STEP_LABELS)` from `apps/web/src/lib/steps.ts`
- `buildSteps()` returns array of steps with status (`completed` | `current` | `pending`) based on current workflow step index
- This ensures all pages show consistent progression without duplication

### Page Transitions

**Cross-page animation** (when moving between workflow stages):

- Triggered in `apps/web/src/App.tsx` when `stage` state changes
- Uses `AnimatePresence mode="wait"` to ensure outgoing page exits before incoming page enters
- Each page wrapped in `motion.div` with:
  - Entry: `opacity: 0, y: 20` → `opacity: 1, y: 0`
  - Exit: `opacity: 0, y: -20`
  - Duration: 0.3s

**Panel animations** (within a page):

- Left panels (transcript, context) animate in from left: `x: -40, opacity: 0` → `x: 0, opacity: 1`
- Right panels (analysis, collateral) animate in from right: `x: 40, opacity: 0` → `x: 0, opacity: 1`
- Spring transition: `type: 'spring', stiffness: 300, damping: 30`
- Staggered delays: left panel 0.1s, right panel 0.15s (for visual cascade)

### Feedback Input

**LiveAnalysisReview** feedback textarea:

- 20-line textarea for user notes to refine pain point extraction
- Sent to API as `feedback` parameter in `/workflows/:id/steps` call with `step: 'analyze'`
- LLM prompt conditions on this feedback to prioritize matching pain points
- Button label changes: "Run analysis" → "Run analysis with feedback" when textarea has text
- Clears after successful API call

Sidebar step states are derived from `workflow.currentStep` via a `buildSteps` helper, rather than hardcoded per-page constants.
