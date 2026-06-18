# AGENTS.md

## Session Start

1. Read this file
2. Read `PRODUCT.md` (the product entrypoint), which points to the canonical
   `docs/PRODUCT.md`; see `docs/README.md` for the full doc index and which
   doc to read for a given task
3. Do not proceed until these steps are complete

## Project

GTM Workbench is an AI-assisted GTM workspace built on top of Interchange. Users get a personal agent (Myra), shared workspace agents (Oat, others), and workflows for turning call data into publishable collateral. For current product and architecture details, read the scribe-managed docs.

### Monorepo layout

- `interchange/` — Interchange dependency. Do not modify.
- `apps/web/` — React 19 + Vite + Tailwind CSS. Human-facing UI.
- `apps/hub/` — Hono + TypeScript. Backend, pipeline, persistence.
- `apps/sidecar/` — Interchange sidecar runtime.
- `packages/` — Shared packages (`@workbench/*`).
- `interchange/packages/` — Interchange packages (`@intx/*`).

### Apps stay generic; packages own the domain

Domain knowledge — workflow definitions, status vocabularies, credential requirements, prompts, artifact kinds, business rules — lives in `packages/*`. Apps are thin hosts: wire HTTP routes, render UI, delegate every product decision to a package. If you find yourself encoding a product rule inside `apps/web` or `apps/hub`, it belongs in a package.

### Stack

- Bun (1.2+), Hono, TypeScript, Drizzle ORM, PostgreSQL (port 5433)
- Frontend: React 19, Vite, Tailwind CSS, Framer Motion
- Agent runtime: `@intx/agent`

## Interchange Is the Operating System

Every agent lifecycle operation, credential flow, session, grant, and inference call goes through Interchange. Stop and read Interchange before writing anything in these domains.

### Mandatory lookup before implementing

1. `interchange/docs/` — AUTH.md, ARCHITECTURE.md, CREDENTIALS.md, MESSAGE.md, API.md
2. `interchange/packages/` — search the relevant package source
3. Check exports of `@intx/hub-common`, `@intx/db`, `@intx/types`, `@intx/hub-api`, `@intx/hub-sessions`
4. Only implement from scratch if Interchange genuinely does not cover it — explain why in the PR

### What Interchange owns — never reimplement

| Domain                  | What Interchange does                                                                        | Where to look                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Credential resolution   | Resolves from tenant hierarchy by `providerName` + `source` + optional `name`                | `@intx/db` → `resolveCredentialRequirement`, `resolveOneCredential` |
| Agent launch            | Resolves `credentialRequirements` → builds inference sources → launches via sidecar          | `@intx/hub-sessions` → `SessionService.launchSession`               |
| Credential requirements | Interchange resolves them at launch; `source: 'tenant'` = tenant-owned (`principalId: null`) | `@intx/types` → `CredentialRequirement`                             |
| Grant resolution        | Collects all grants for a principal including role-based grants                              | `@intx/db` → `createGrantStore` → `collectGrants`                   |
| Session orchestration   | Session lifecycle, sidecar registration, reconnect                                           | `@intx/hub-sessions` → `createHubSessionOrchestrator`               |
| ID generation           | Typed, prefixed IDs for every entity                                                         | `@intx/hub-common` → `generateId`                                   |
| LLM inference           | All inference calls go through the agent runtime                                             | `@intx/agent` — never direct fetch to LLM endpoints                 |
| DB schema + types       | Tables, ID formats, row types                                                                | `@intx/db/schema`, `@intx/types`                                    |

### Credential + launch pattern

```ts
// Agent definition — declare what you need
credentialRequirements: [{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }]
// Credential — tenant-owned, not principal-owned
{ principalId: null, tenantId, providerId, name: 'Myra LLM', ... }
// Launch — no credentialIds; Interchange resolves from requirements
sessionService.launchSession({ agentId, instanceId, ... })
```

### Agent credentials vs tool credentials

- `credentialRequirements` are **inference-only**. Tool-only providers (`firecrawl`, `granola`, `exa`, `xai`, `reddit`, `scrapecreators`) must NOT go in `credentialRequirements` — they break sidecar launch with `Source provider "X" is not registered`.
- For tool credentials: add the `providerName` to `credentialProviderNames` on the deploy descriptor; resolve at tool execution time via `resolveCredentialRequirement` in the hub tool registry.
- Third-party generation APIs (e.g. Gamma): direct HTTP from a hub tool is fine; resolve the key via `resolveCredentialRequirement`; document in the package README.

## Worktree Setup

```bash
git submodule update --init   # Interchange submodule is not auto-initialized
bun install                   # node_modules are not shared between worktrees
```

## Commit Process

Each step is a separate commit.

1. **Red** — write tests, confirm they fail. Commit: `"Add tests for <feature/fix>"`
2. **Green** — minimal change to pass tests, run full build pipeline. Commit: `"<feature/fix>: <what changed>"`
3. **Docs** — run the scribe skill if product/architecture/implementation docs are affected. Commit: `"Update docs: <what changed>"`

- One logical change per commit; messages describe the change, not the task
- Never auto-commit; present the message and wait for confirmation

## Testing

- **80% merged line coverage is a hard floor.** Measure with `bun run coverage`. Never let a change drop below it.
- Every package with runnable code must define `test` and `test:coverage` scripts. Pure type-only packages exempt (document it).
- Assert behavior, not execution — no tautologies, no render-without-crash tests.
- `screen.getByText('X')` throws if absent — do not append `.toBeDefined()`.
- Never assert the mock. A test that checks a value it fed to a mock proves nothing.
- Mock only at the `@intx/*` or a true module boundary via `mock.module(...)`.

## Build Requirements

```bash
bun run format && bun run lint && bun run check && bun run test
```

`bun run check` must pass with zero errors in `apps/`, `packages/`, `scripts/` before any commit. Errors inside `interchange/` are pre-existing upstream issues.

## Dockerfile Maintenance

Each image uses a targeted `COPY` list. When you add/remove/rename a package or app:

- New `packages/*` dep → add `COPY packages/<name>/` and `COPY packages/<name>/package.json` in every image that depends on it.
- Removed package → remove its lines from all Dockerfiles.
- The manifest-copy section (`COPY packages/*/package.json` before `bun install`) must list every workspace member.

## Credential Seeding Maintenance

When you add a `@workbench/tools-*` package with a credential `providerName`:

- Add an entry to `buildEntries()` in `apps/hub/bin/seed-credentials.ts`.
- Add the env var to `.env.example`.
- Add a `buildEntries()` test asserting the entry appears/disappears with the env var.
- Add the `providerName` to the agent's `credentialProviderNames` (never `credentialRequirements`).

Keyless tools need no seed entry — say so in the package README.

## Issue Workflow

- Mark In Progress before starting
- Create a worktree off `origin/staging` (not local staging); run submodule + bun install
- Follow red → green → docs commit sequence
- Self-review before pushing; rebase on `origin/staging`; PR targets `staging`
- Post self-review summary as a PR comment; mark Done after PR is created

## Code Style

- No comments unless the WHY is non-obvious. Never narrate what the code does.
- TypeScript strict mode. Load `gaas:typescript` before writing or reviewing TypeScript.
- No `console.log` — use `@intx/log` in hub/sidecar, nothing in web.
- No IIFEs or dynamic imports in production — use named async functions and static imports.
- No fallbacks for required values — `requireEnv()` for env vars, fail loudly. Fallbacks only for genuinely optional values with a single contract-guaranteed default.
- No nested ternaries — use `if`/`else` or early returns.
- All env var validation lives in `apps/hub/src/config.ts`.
- Do not modify `eslint`, `prettier`, `tsconfig`, or `package.json` unless explicitly asked.

## Types — arktype is the default (`packages/` and `apps/`)

Define new types with `type(...)` from `arktype`, deriving the TypeScript type via
`typeof Schema.infer`. This is the rule for new code in **both `packages/` and `apps/`**
(`apps/hub` and `apps/web`) — prefer it over `interface` or bare `type` aliases.

- **Parse at every trust boundary.** API responses, request bodies, anything typed
  `unknown` — validate through an arktype schema, never cast (`as T`) untrusted data.
- **Internal, already-trusted shapes** (React props, local state, values you just
  constructed) may stay plain `type`/`interface` — arktype's runtime validation buys
  nothing there. When a shape is also serialized across the API, define it once as an
  arktype schema and share it.
- When you touch a raw type that crosses a boundary, upgrade it to arktype — in a
  separate commit, after checking downstream `infer`/narrowing usage.
- `interchange/` (`@intx/*`) is out of scope — never modify upstream types.

## Dependency Injection

Inject stateful resources (DB, HTTP clients). Import stateless singletons (config, loggers) directly.

```ts
export function createWorkflowRouter(db: DB['db']): Hono { ... }  // correct
export function createWorkflowRouter(db: DB['db'], config: Config): Hono { ... }  // wrong
```

In tests, mock at the module boundary (`mock.module(...)`) — do not inject fakes as function arguments.

## Frontend (apps/web)

Detailed rules in `apps/web/CLAUDE.md`; non-negotiables:

- **TanStack Query only** for data fetching. No `useEffect` + `fetch`.
- **Gate queries with `enabled`**; `staleTime ≥ 5 min` for catalog/static data.
- **`mutateAsync` must have `.catch()`** — never `void mutateAsync().then()`.
- **ArkType at the boundary.** Parse API responses / `unknown` through ArkType; plain types for already-trusted shapes.
- Derive component behavior from the loaded resource, not from navigation props.

## Constraints

- Do not make CRM sync (Attio) a dependency for v1
- Do not build a fully automated pipeline — keep humans in the loop
- Exports: markdown, clipboard, email draft, Slack, Typefully

## Personality

- Professional, plain language, no jargon you haven't earned
- Concise — one clear sentence beats a paragraph
- No emojis
