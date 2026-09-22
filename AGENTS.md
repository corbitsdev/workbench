# Workbench — Agent Guide

Workbench is a client of [Interchange](https://github.com/faremeter/interchange).
The hub mounts only stock `@intx/hub-api` routes plus a set of Corbits
libraries, each mounted once (`@corbits/mailbox`, `@corbits/memory`,
`@corbits/artifacts`, `@corbits/webhooks`, `@corbits/cron`, `@corbits/mcp`, an
OAuth library on `@corbits/oauth-core`); any other hub mount is cutover debt with a Linear
issue, never a pattern to extend. A workbench is a plain
Interchange tenant, nothing more. The web client sets itself up over stock
routes on start (auth → tenant → definitions/credentials/grants); the hub
never seeds data on a client's behalf.

## Ground rules

- **Interchange is the platform.** Never reimplement credential resolution,
  agent launch, session orchestration, inference, ID generation, or the
  workflow runtime — consume `@intx/*` as published packages. `vendor/intx`
  holds hand-copied fallbacks for capabilities not yet published, tracked
  with kill dates in [VENDORED.md](VENDORED.md); the upstream repository is
  never modified.
- **Apps stay generic; packages own the domain.** A product rule inside
  `apps/*` belongs in a package. `workflows/*` are plain npm-shaped packages,
  deployable to any stock Interchange hub through the stock deploy route —
  this repo does not publish them to npm.
- **Myra is the one default agent.** `agents/myra` is the assistant
  that uses Workbench on the person's behalf; every agent package under
  `agents/*` is trim — `index.ts` (plus `system-prompt.ts` when the prompt
  is large) — with no agent-owned artifact client/tool code of its own.
- **No fallbacks.** Cut over cleanly — never leave a legacy path beside a
  new one. Config/manifest objects are explicit literals; the one exception
  is an optional key under `exactOptionalPropertyTypes` (see below), where
  `...(x !== undefined ? { k: x } : {})` is the only correct way to omit it.
- **Parse at every trust boundary.** arktype schemas for env, request
  bodies, and external data; never `as T` untrusted input.
- **Custom DB tables live on their own Postgres schema**, with foreign keys
  back to Interchange's tenant/principal tables. Each package ships one
  idempotent migration, which the hub applies itself at boot.
- **Ancestor-walkable except grants.** Credentials, tools, and definitions
  inherit down the tenant tree; grants never do.
- **This repo is public.** No secrets or credentials, ever — `.env.example`
  is the only tracked env file. Anything sensitive (client names, internal
  context, infra/deploy rulings) goes in Linear, not in commits, PRs, or
  docs.
- **Core UI components live in
  [corbitsdev/react-ui](https://github.com/corbitsdev/react-ui).** Build
  reusable components there; only workbench-specific composition lives here.

## Working conventions

- `bun run check` (typecheck, lint, fmt, test) must pass before every
  commit. There are no custom structural check scripts; a rule lives in
  the code or schema itself or it does not exist.
- Worktrees live in `.worktrees/<branch>`; branch = `cl-<issue#>-<slug>`.
- Commit sequence per change: tests first ("Add tests for X"), then
  implementation ("X: what changed"), then docs ("Update docs: X"). One
  logical change per commit; commit messages are written for a public
  audience.
- Bun loads repo-root `.env`, so an unset test inherits
  `HUB_DATA_DIR=.data/hub` inside this work tree — the hub's git-on-disk
  init can then walk up to the enclosing `.git` and land a genesis commit
  on the working branch. Tests that boot the hub or touch seed/deploy git
  paths must call `installDisposableHubDataDir()` from
  `e2e/lib/disposable-hub-data-dir.ts`; never delete the `HUB_DATA_DIR` key.
- Deployment mechanics are not settled enough to state here — see
  [IMPLEMENTATION.md](IMPLEMENTATION.md)'s Deployment section first.

Env flags (unset behavior):

| Flag                                                        | If unset                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                              | DB-gated suites skip locally; `CI=true` makes it a hard failure on jobs that provision Postgres |
| `HUB_DATA_DIR`                                              | hub boot fails — required runtime config                                                        |
| `CI`                                                        | set by GitHub Actions; not a caller flag                                                        |
| `E2E_PROVIDER` / `E2E_PROVIDER_API_KEY` / `OLLAMA_BASE_URL` | live-inference e2e stays on the noop/stub path                                                  |

## Tests

Two homes only. A load-bearing unit test sits beside the module it covers
(`src/**/*.test.ts`); a load-bearing integration or DB-backed suite lives
under root `e2e/<area>/`, with shared helpers in `e2e/lib/`. No `test/`
directory exists anywhere — not in apps, packages, agents, or tools. A test
that isn't load-bearing (pins a literal, a shape, a re-export, or re-proves
Interchange's own behavior) is deleted, not moved.

Tests are meaningful red/green tests only — no coverage theater. An
outdated test is deleted in the same PR that breaks it, not adapted to keep
passing; rebuilding coverage for the area it covered happens under CL-8150.

## Conventions

- Report every caught error through `reportError` from
  `@corbits/error-sink` — never a bare `catch {}`.
- A package's `browser-safe` subpath never imports a server-only
  dependency (`postgres`, `drizzle-orm`, `hono`, any `@intx/*`).
- Every package needs a `LICENSE` file (LGPL-2.1).
- A dependency declared in the root `catalog` is consumed as `catalog:`.
- `exactOptionalPropertyTypes: true` — omit an optional key rather than
  assigning it `undefined`.
- A custom table that gets deleted is hard-removed: delete the schema code,
  no drop migration. Cutovers are breaking; reset the database.

## Docs map

- [README.md](README.md) — quickstart and repo layout
- [PRODUCT.md](PRODUCT.md) — what Workbench is and why
- [ARCHITECTURE.md](ARCHITECTURE.md) — system structure
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — concrete stack, deployment, open
  questions
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution flow and CLA
- [LICENSE.md](LICENSE.md) — GPLv2 with AI Exception
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities
- [VENDORED.md](VENDORED.md) — the vendoring ledger and its rules
- [DESIGN.md](DESIGN.md) — the UI design system canon; a screen that
  disagrees with it is wrong until a review changes the doc
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — product-term to platform-term mapping
- [docs/local-dev.md](docs/local-dev.md) — running fully local with Ollama
