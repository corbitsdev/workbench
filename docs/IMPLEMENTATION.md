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

- **Applications**: `apps/web/`, `apps/hub/`
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

## Authentication

### Google OAuth Configuration

Google OAuth is required for all users. Configuration:

- **Client ID / Secret**: Configured via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.workbench`
- **Redirect URI**: `http://localhost:5174/auth/callback` (local) or production equivalent
- **Domain Allowlist** (optional): `GOOGLE_ALLOWED_DOMAINS` — comma-separated domains (e.g., `example.com,partner.com`). If set, only users with email addresses in these domains can authenticate. If unset, any Google account is allowed.
- **Session Handling**: Sessions are stored in secure, HTTP-only cookies with CSRF protection. Session expiry is configurable via environment variables.
- **Trusted Origins**: The API whitelist CORS origins via `TRUSTED_ORIGINS` (comma-separated). Required for local dev and production deployments.

### Token-Based System Prompts (LLM)

When generating collateral, the agent receives **type-aware system prompts** tailored to the output format:

- **Email**: Focus on clarity, call-to-action, and conversational tone. Prompt emphasizes sales urgency and personal tone.
- **LinkedIn**: Emphasis on thought leadership, industry insight, and shareability. Prompt encourages professional storytelling.
- **One-Pager**: Structured, scannable format. Prompt specifies bullet points, header hierarchy, and data density.
- **Battlecard**: Competitive positioning and objection handling. Prompt emphasizes structured comparison and messaging.

Each prompt includes the pain point context and selected quote to ground responses in the actual customer voice. This ensures generated collateral is format-appropriate and maintains consistency in tone per output type.

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
bun run --filter @workbench/hub dev

# Terminal 2 — Web
bun run --filter @workbench/web dev
```

## Build Pipeline

```bash
bun run format    # Prettier
bun run lint      # ESLint + docs freshness
bun run check     # tsc -b --noEmit
bun run test      # bun test
```

Or via `make all` if Makefile is available.

## Railway Deployment

The workbench deploys as three separate Railway services from the same repo, all watching the `staging` branch (or `main` for production). This is a **shared monorepo**: every service builds with the repo root as its Docker build context (Root Directory `/`), because they all depend on the shared lockfile, `packages/*`, and the vendored `interchange/packages/*` workspaces.

### Services

| Service | Config file                 | Dockerfile                | Purpose                                 |
| ------- | --------------------------- | ------------------------- | --------------------------------------- |
| Hub     | `apps/hub/railway.toml`     | `apps/hub/Dockerfile`     | Hono API, DB migrations                 |
| Web     | `apps/web/railway.toml`     | `apps/web/Dockerfile`     | Static SPA (Vite build served by Caddy) |
| Sidecar | `apps/sidecar/railway.toml` | `apps/sidecar/Dockerfile` | Interchange sidecar, agent lifecycle    |

Per Railway's monorepo model, the config file does **not** follow the Root Directory — set each service's Config-as-Code path to the absolute repo-root path (e.g. `/apps/hub/railway.toml`). `dockerfilePath` inside each config is relative to the build context (repo root). Each config declares `watchPatterns` so a service redeploys only when its own code or shared dependencies change.

### Dockerfiles

The hub and sidecar Dockerfiles follow the same pattern:

1. **Builder stage** (`oven/bun:1.3-alpine`): fetches and verifies `interchange/` from GitHub at a pinned commit + SHA256, installs workspace dependencies, builds the app
2. **Runtime stage** (`oven/bun:1.3-slim`): copies only what is needed to run

The pinned `INTERCHANGE_COMMIT` and `INTERCHANGE_SHA256` args must be updated together across all three Dockerfiles whenever interchange is upgraded.

`apps/sidecar/Dockerfile` builds nothing and runs directly from TypeScript source via `bun run`. `apps/web/Dockerfile` runs `vite build` in the builder stage (still needing full repo context for `@workbench/shared`) and serves the static output via Caddy with an SPA fallback to `index.html`; it runs no Node/Bun process at runtime. The hub no longer builds or serves the web assets — the web service owns them, and the SPA reaches the API via the build-time `VITE_API_BASE_URL`.

### Volumes

Both services require a **persistent volume** mounted in the Railway dashboard. Loss of volume data breaks the sidecar–hub trust relationship and requires re-provisioning.

| Service              | Mount path | Env var                  | Contents                          |
| -------------------- | ---------- | ------------------------ | --------------------------------- |
| Sidecar              | `/data`    | `SIDECAR_DATA_DIR=/data` | Per-agent git repos, key pairs    |
| Hub (if self-hosted) | `/data`    | `HUB_DATA_DIR=/data`     | Agent repo mirrors, signing state |

### Sidecar Environment Variables

| Variable           | Description                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `HUB_WS_URL`       | WebSocket URL of the Interchange hub (e.g. `wss://hub.example.com/api/sidecars/ws`)                |
| `SIDECAR_ID`       | Stable opaque identifier for this sidecar instance (e.g. `gtm-staging`). Any slug format is valid. |
| `SIDECAR_TOKEN`    | Auth token for hub registration                                                                    |
| `SIDECAR_DATA_DIR` | Path on the persistent volume (e.g. `/data`)                                                       |

### One-Time Dashboard Setup (per service)

Volumes and env vars cannot be provisioned via `railway.toml` — they must be configured manually in the Railway dashboard once per service:

1. Create the service, point it at the repo and select the appropriate config file path
2. Add a volume and mount it at `/data`
3. Set the env vars listed above
4. Every subsequent push to the watched branch deploys automatically

## Agent Runtime and LLM Inference

### Architecture

All LLM inference uses `@intx/agent` from `interchange/packages/agent`. The agent runtime provides:

- **Unified inference interface** across OpenAI, Anthropic, Google GenAI, and OpenAI-compatible endpoints
- **Configuration management** via `InferenceSource` (model, API key, base URL, provider)
- **Error handling and logging** with classified error types and structured output
- **Conversation history persistence** via pluggable context stores (isogit by default, in-memory for ephemeral tasks)
- **Tool execution framework** for agent-driven workflows

### Using `@intx/agent` for LLM Inference

**Single-call inference** (extraction, analysis, one-shot generation):

1. Create an `InferenceSource` from environment variables:

   ```typescript
   import type { InferenceSource } from '@intx/types/runtime';

   const source: InferenceSource = {
     id: `my-task-${id}`,
     provider: 'openai', // 'anthropic', 'google-genai', or OpenAI-compatible
     baseURL: process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1',
     apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
     model: process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini',
   };
   ```

2. Create a temporary agent with an ephemeral context directory:

   ```typescript
   import { createAgent } from '@intx/agent';
   import { tmpdir } from 'node:os';
   import { join } from 'node:path';
   import { randomUUID } from 'node:crypto';

   const contextDir = join(tmpdir(), `task-${randomUUID()}`);
   const agent = await createAgent({
     contextDir, // Automatically cleaned up after close()
     sources: [source],
     defaultSource: source.id,
     systemPrompt: 'Your system instructions...',
     tools: [], // Add tool definitions if needed
     closeTimeoutMs: 1000, // Fast shutdown for ephemeral tasks
   });
   ```

3. Send your prompt and extract the response:

   ```typescript
   const result = await agent.send(userMessage);
   await agent.close();

   // result.reply is the LLM's text response
   const data = JSON.parse(result.reply); // or text parsing
   ```

### Pain Point Extraction

Implemented in `apps/hub/src/lib/extraction.ts`:

**LLM Path** (when `OPENAI_COMPATIBLE_API_KEY` is configured):

- **Model**: Configurable via `OPENAI_COMPATIBLE_MODEL` (default: `gpt-4o-mini`)
- **Endpoint**: Configurable via `OPENAI_COMPATIBLE_BASE_URL` (default: `https://api.openai.com/v1`)
- **Runtime**: Uses `@intx/agent` with temporary context directory (no persistence)
- **Format**: JSON response with structured pain points
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
- **Error handling**: Agent errors classified and logged via structured logging

**Fallback Path** (no API key or LLM failure):

- **Strategy**: Keyword heuristic on transcript lines
- **Keywords** with mapped severity:
  - High severity: `difficult`, `frustrat*`, `pain`, `generic`, `waste`, `never`, `always`, `every`
  - Medium severity: `problem`, `challenge`, `slow`, `manual`
- **Deduplication**: Extracted points are deduplicated on first 60 chars of context
- **Limit**: Returns up to 5 pain points
- **Selection state**: All extracted points marked `selected: true` by default

### Collateral Generation and Improvement

1. **Generate**: Agent takes selected pain points and requested collateral types, returns structured collateral (email, LinkedIn, one-pager, battlecard) per point. Each type receives a **type-aware system prompt** (see Token-Based System Prompts above) to ensure format-appropriate output.
2. **Improve**: Agent accepts feedback + existing collateral + type context, returns improved version with applied changes (shortening, tone adjustments, etc.)

All agent outputs are runtime-validated with `arktype` before persistence.

### Granola API v1 Integration

**Intake Path** (secondary):

When configured with `GRANOLA_API_KEY`, the workbench can ingest recent sales calls from Granola's public API:

- **Endpoint**: Granola API v1 `/calls` endpoint
- **Authentication**: Bearer token via `GRANOLA_API_KEY`
- **Integration**: Call transcripts are fetched and stored as `source: "granola"` in the `transcript` table, distinguishing them from manually pasted transcripts
- **Usage**: Users can optionally browse and select a recent call instead of pasting a transcript
- **Scope**: Granola integration is entirely optional; paste-first is the primary intake path

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
