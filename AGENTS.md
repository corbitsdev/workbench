# AGENTS.md

## Session Start

1. Read this file
2. Read `PRODUCT.md` for current product state
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

`apps/*` should be as generic as possible. Domain knowledge — workflow definitions, status vocabularies, credential requirements, prompts, artifact kinds, business rules — lives in `packages/*` and is imported by the apps. An app is a thin host: it wires HTTP routes, renders UI, and delegates every product decision to a package.

Concretely:

- Define domain types and unions in the owning package, not in an app. An app consuming a value it does not own treats it as an opaque `string` rather than re-declaring the type.
- If you find yourself encoding a product rule (what a workflow needs, what a status means, what to generate) inside `apps/web` or `apps/hub`, it belongs in a package.
- Prefer the most specific package over the catch-all. A workflow concept belongs in the workflow package, not in a generic `shared` grab-bag.

### Stack

- Package manager: Bun (1.2+)
- Frontend: React, Vite, Tailwind CSS, Framer Motion
- Backend: Hono, TypeScript, Drizzle ORM
- Agent runtime: `@intx/agent`
- Persistence: PostgreSQL (port 5433 in compose)

## Interchange Is the Operating System

Interchange is not a library we use occasionally. It is the operating system this product runs on. Every agent lifecycle operation, credential flow, session, grant, and inference call goes through Interchange. The workbench hub is a thin product layer on top of it — not a reimplementation of it.

**This has burned us before.** We once wrote a full credential-grant-at-launch flow (passing credentialIds manually, granting them to instance principals, building inference sources by hand) when Interchange already does all of this via `credentialRequirements` on the agent definition + `resolveCredentialRequirement` at launch. The result was a broken onboarding flow, a week of debugging, and code we had to throw away.

**Do not repeat this. Stop and read Interchange before writing anything.**

### Mandatory lookup before implementing anything

1. `interchange/docs/` — read AUTH.md, ARCHITECTURE.md, CREDENTIALS.md, MESSAGE.md, API.md for the domain you're touching
2. `interchange/packages/` — search for the relevant package and read its source
3. Check exports of `@intx/hub-common`, `@intx/db`, `@intx/types`, `@intx/hub-api`, `@intx/hub-sessions`
4. Only implement from scratch if Interchange genuinely does not cover it — and if so, explain why in the PR

### What Interchange owns — never reimplement these

| Domain                  | What Interchange does                                                                     | Where to look                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Credential resolution   | Resolves credentials from tenant hierarchy by `providerName` + `source` + optional `name` | `@intx/db` → `resolveCredentialRequirement`, `resolveOneCredential`                                  |
| Agent launch            | Resolves `credentialRequirements` → builds inference sources → launches via sidecar       | `@intx/hub-sessions` → `SessionService.launchSession`                                                |
| Credential requirements | Agent definitions declare what they need; Interchange finds and resolves them at launch   | `@intx/types` → `CredentialRequirement`; `source: 'tenant'` means tenant-owned (`principalId: null`) |
| Grant resolution        | Collects all grants for a principal including role-based grants                           | `@intx/db` → `createGrantStore` → `collectGrants`                                                    |
| Session orchestration   | Manages session lifecycle, sidecar registration, reconnect                                | `@intx/hub-sessions` → `createHubSessionOrchestrator`                                                |
| ID generation           | Typed, prefixed IDs for every entity                                                      | `@intx/hub-common` → `generateId`                                                                    |
| LLM inference           | All inference calls go through the agent runtime                                          | `@intx/agent` — never direct fetch to LLM endpoints                                                  |
| DB schema + types       | Tables, ID formats, row types                                                             | `@intx/db/schema`, `@intx/types`                                                                     |

### The correct credential + launch pattern

Credentials are stored **tenant-owned** (`principalId: null`). Agent definitions declare **credential requirements**. Interchange resolves them at launch time by walking the tenant hierarchy.

```ts
// Agent definition — declare what you need
credentialRequirements: [{ providerName: 'openai-compatible', source: 'tenant', name: 'Myra LLM' }]

// Credential creation — tenant-owned, not principal-owned
{ principalId: null, tenantId, providerId, name: 'Myra LLM', ... }

// Launch — no credentialIds; Interchange resolves from requirements
sessionService.launchSession({ agentId, instanceId, ... }) // sources resolved internally
```

The frontend's job is to save the credential. The hub's job is to launch the agent. Neither should pass credential IDs through the launch call.

### Specific rules

- `generateId` — import from `@intx/hub-common`, never reimplement
- LLM inference — use `@intx/agent`, never direct `fetch()` to LLM endpoints
- Tenant/principal/grant operations — use Interchange's DB schema and resolution functions from `@intx/db`
- ID formats, table schemas, type definitions — read `@intx/db/schema` and `@intx/types` before defining your own
- Credential resolution — use `resolveCredentialRequirement` from `@intx/db`
- Agent launch — use `SessionService.launchSession`; never build inference sources manually
- Do not modify `interchange/` unless explicitly asked

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

## Testing

Tests are not an afterthought and not a cleanup pass. Every behavioral change is developed **red → green**: write the test first, watch it fail for the right reason, then write the minimal code to make it pass. New code ships with its tests in the same change — never "tests later."

### Red/green workflow

1. **Red** — write the test for the new or changed behavior first. Run it; confirm it fails for the reason you expect.
2. **Green** — implement the minimal change to make it pass.
3. **Refactor** — clean up with the test green.

This is the same sequence the Commit Process encodes (tests-first commit, then implementation). A change that adds or alters behavior with no accompanying test is incomplete.

### Coverage policy

- Measure with `bun run coverage` (whole repo, merged) or `bun run test:coverage` (one package). The merged gate lives in `scripts/coverage-merge.ts`.
- **80% merged line coverage is a hard floor. Never let a change drop below it.** If your change lowers coverage, add tests in the same change until it recovers — do not push a regression.
- **80% is the floor, not the goal.** Every change should leave coverage equal or higher; the standing target is always *higher* than where we are now. An uncovered line you touch is yours to cover.
- Any package containing runnable code must define `test` and `test:coverage` scripts so the merged gate sees it. Pure type-only packages are exempt (document the exemption).
- Coverage is line coverage only (Bun emits no branch/per-function lcov).

### Test quality bar

This is the difference between regression protection and theater:

- **Assert behavior, not execution.** No tautologies (`expect(true).toBe(true)`), no render-without-crash tests, no test whose only point is that code ran.
- **A throwing query is already the assertion.** `screen.getByText('X')` throws if absent — do not append `.toBeDefined()` to it. For an explicit presence/absence check, use `queryBy…()` with `.not.toBeNull()` / `.toBeNull()`.
- **Never assert the mock.** A test that only checks a value the test itself fed to a mock proves nothing about the code under test.
- **Mock only at the Interchange (`@intx/*`) or a true module boundary**, via `mock.module(...)`. Inject stateful collaborators (db, services) as arguments — never module-mock your own package's public surface. (See Dependency Injection.)
- Assert user-visible behavior and call contracts. For generated text such as prompts, assert structure/contract — never brittle full-string equality.

## Build Requirements

Run the full pipeline before declaring any task complete:

```bash
bun run format
bun run lint
bun run check   # tsc -b across the full project graph
bun run test
```

Pre-existing failures must be identified explicitly. Never silently skip a failing step.

### Typecheck gate

`bun run check` (typecheck) **must pass with zero errors in our code** before any commit, push, or PR. Errors inside `interchange/` are pre-existing upstream issues and may be ignored, but every error in `apps/`, `packages/`, and `scripts/` must be resolved first.

Do not merge or push while typecheck is red on our code. If a change introduces a new type error, fix it before committing — do not defer it.

## Dockerfile Maintenance

Each image (`hub`, `sidecar`, `admin-ui`, `web`) uses a targeted `COPY` list instead of `COPY . .`. When you add, remove, or rename a package or app, you must update every affected Dockerfile:

- Adding a new `packages/*` entry as a dependency of hub or sidecar → add a `COPY packages/<name>/ packages/<name>/` line and a `COPY packages/<name>/package.json packages/<name>/` line in every image that depends on it (directly or transitively).
- Removing a package → remove its lines from all Dockerfiles.
- Adding a new `apps/*` entry → create a new Dockerfile following the same pattern; do not use `COPY . .`.

The manifest-copy section (all the `COPY packages/*/package.json` lines before `bun install`) must list every workspace member regardless of whether the image uses it — bun needs the full graph to resolve the lockfile.

## Issue Workflow

When implementing a Linear issue:

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

- No comments unless the WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug). If removing the comment wouldn't confuse a future reader, don't write it. Never narrate what the code does.
- TypeScript strict mode. Load the `gaas:typescript` skill before writing or reviewing TypeScript.
- No `console.log` — use `@intx/log` structured logging in hub/sidecar, nothing in web
- No emojis in code, comments, or messages
- No IIFEs or dynamic imports in production code — use named async functions and static imports.
- No fallbacks for required values — prefer explicit checks and fail loudly. Use `requireEnv()` for env vars; never silently substitute a default.
- No nested ternaries or similarly compressed conditional expressions — use `if`/`else` or early returns.
- Use full, descriptive variable and function names. Clean, readable design over brevity.
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
