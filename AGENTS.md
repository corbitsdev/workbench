# AGENTS.md

## Session Start

1. Read this file
2. Read `CONVENTIONS.md` (or `/.agents/skills/style/SKILL.md`) for code style
3. Read `PRODUCT.md`, `ARCHITECTURE.md`, `IMPLEMENTATION.md` for current project state
4. Scan `/.agents/skills/` for available local skills
5. Do not proceed until these steps are complete

## Project

GTM Workbench is an AI-assisted GTM workspace built on top of Interchange. Users get a personal agent (Myra), shared workspace agents (Oat, others), and workflows for turning call data into publishable collateral. For current product and architecture details, read the scribe-managed docs.

### Monorepo layout

- `interchange/` — Interchange dependency. Do not modify.
- `apps/web/` — React 19 + Vite + Tailwind CSS. Human-facing UI.
- `apps/hub/` — Hono + TypeScript. Backend, pipeline, persistence.
- `apps/sidecar/` — Interchange sidecar runtime.
- `packages/` — Shared packages (`@workbench/*`).
- `interchange/packages/` — Interchange packages (`@intx/*`).

### Stack

- Package manager: Bun (1.2+)
- Frontend: React, Vite, Tailwind CSS, Framer Motion
- Backend: Hono, TypeScript, Drizzle ORM
- Agent runtime: `@intx/agent`
- Persistence: PostgreSQL (port 5433 in compose)

## Interchange First

**Before writing any new code, check if Interchange already does it.**

Interchange (`interchange/packages/`) provides: agent runtime, inference, tenant/principal/grant management, credential resolution, session handling, mail transport, git-backed context storage, observability, and more.

The cost of reimplementing something Interchange already does is high — divergent ID formats, missing invariants, duplicated logic that drifts. The cost of reading the source first is low.

**Mandatory lookup sequence before implementing anything:**

1. Check `interchange/docs/` — AUTH.md, ARCHITECTURE.md, CREDENTIALS.md, MESSAGE.md, API.md
2. Search `interchange/packages/` for the relevant package
3. Check if `@intx/hub-common`, `@intx/db`, `@intx/types`, or `@intx/hub-api` exports what you need
4. Only implement from scratch if Interchange genuinely does not cover it

**Specific rules:**

- `generateId` — import from `@intx/hub-common`, never reimplement
- LLM inference — use `@intx/agent`, never direct `fetch()` to LLM endpoints
- Tenant/principal/grant operations — use Interchange's DB schema and resolution functions from `@intx/db`
- ID formats, table schemas, type definitions — read `@intx/db/schema` and `@intx/types` before defining your own
- Credential resolution — use `resolveCredentialRequirement` from `@intx/db`

## Worktree Setup

Every new worktree requires these steps before doing any work:

```bash
git submodule update --init   # Interchange submodule is not auto-initialized
bun install                   # node_modules are not shared between worktrees
```

Missing either step causes `@intx/*` imports to fail at test/build time.

## Commit Process

Follow this workflow. Each step is a separate commit.

### Step 1 — Tests first (red)
```
Write tests for what you are about to change
→ Confirm they fail
→ Commit: "Add tests for <feature/fix>"
```

### Step 2 — Implement (green)
```
Make the minimal change to pass the tests
→ Run full build pipeline
→ Commit: "<feature/fix>: <what changed>"
```

### Step 3 — Docs
```
Run the scribe skill if the change affects product, architecture, or implementation docs
→ Commit: "Update docs: <what changed>"
```

### Commit discipline

- One logical change per commit
- Messages are precise and auditable — describe the change, not the task
- Do not auto-commit unless the user explicitly says so
- Always present the commit message and wait for user confirmation

## Build Requirements

Run the full pipeline before declaring any task complete:

```bash
bun run format
bun run lint
bun run check   # tsc -b across the full project graph
bun run test
```

Pre-existing failures must be identified explicitly. Never silently skip a failing step.

## Issue Workflow

When implementing a Linear issue, follow the `linear-issue-workflow` skill (`/.agents/skills/linear-issue-workflow/SKILL.md`):

- Mark the issue In Progress before starting
- Create a worktree off `origin/staging` (not local staging)
- Run `git submodule update --init && bun install` in the worktree
- Follow the test → implement → docs commit sequence
- Self-review before pushing
- Rebase on `origin/staging` before creating the PR
- Create the PR targeting `staging`
- Post self-review summary as a PR comment
- Mark the issue Done after the PR is created

## Code Style

- TypeScript strict mode
- No `console.log` — use `@intx/log` structured logging in hub/sidecar, nothing in web
- No emojis in code, comments, or messages
- No fallbacks for required env vars — use `requireEnv()` and fail loudly at startup
- All env var validation lives in `apps/hub/src/config.ts`

## Dependency Injection

Inject stateful resources (DB connections, HTTP clients). Import stateless singletons (config, loggers, constants) directly.

```ts
// correct — db is stateful
export function createWorkflowRouter(db: DB['db']): Hono { ... }

// wrong — config is not stateful
export function createWorkflowRouter(db: DB['db'], config: Config): Hono { ... }
```

In tests, mock at the module boundary (`mock.module(...)`) — do not inject fakes through function arguments.

## Configuration

Do not modify `eslint`, `prettier`, `tsconfig`, or `package.json` unless explicitly asked.

## Constraints

- Do not make CRM sync (Attio) a dependency for v1
- Do not build a fully automated pipeline — keep humans in the loop
- Do not modify `interchange/` unless explicitly asked
- Session state must be persisted and resumable
- Exports: markdown, clipboard, email draft, Slack, Typefully

## Personality

- Professional, plain language, no jargon you haven't earned
- Concise — one clear sentence beats a paragraph
- No emojis
