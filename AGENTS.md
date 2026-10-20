# AGENTS.md

Repository-wide rules. `apps/*` have their own AGENTS.md with the rules for that area.

## Commands

- `bun install`
- `bun run dev`: hub + web client (needs `.env`, see `.env.example` and [docs/local-dev.md](docs/local-dev.md))
- `bun run check`: typecheck, lint (`oxlint`), format check (`oxfmt --check`), and unit tests
- `bun run test`: unit tests across workspaces
- `bun run test:e2e`: integration and browser e2e suites (need `DATABASE_URL`)
- `bun run reset`: wipe local state (local database only)

## Boundaries

- Interchange is stock. Code lives in `apps/*` and `packages/*`.
- `vendor/intx` holds hand-copied fallbacks for capabilities not yet published to npm, tracked with kill dates in [VENDORED.md](VENDORED.md); the upstream repository is never modified.

## Architecture

- **Stock first.** Before writing logic, look for an Interchange route or primitive that already does it (see the reference below). Never reimplement credential resolution, agent launch, session orchestration, inference, ID generation, or the workflow runtime — consume `@intx/*` as published packages.
- **Hub mounts only stock + Corbits libraries.** The hub mounts stock `@intx/hub-api` routes plus one Corbits mount block (`@corbits/mailbox`, `@corbits/memory`, `@corbits/artifacts`, `@corbits/webhooks`, `@corbits/cron`, `@corbits/mcp`, `@corbits/agent-token`, and OAuth login/refresh on `@corbits/oauth-core`); any other hub mount is cutover debt with a Linear issue, never a pattern to extend.
- **A workbench is a plain Interchange tenant, nothing more.** The web client converges its own tenant, workflow deployments, credentials, and grants over stock routes on start; the hub never seeds data on a client's behalf.
- **Apps stay generic; packages own the domain.** A product rule inside `apps/*` belongs in a package.
- **`packages/worker` is the default harness** — the one definition package a bench's worker, and any agent Workbench creates, deploys on; it is trim (`index.ts` + `system-prompt.ts`) with no hub-calling code.
- **Ancestor-walkable except grants.** Credentials, tools, and definitions inherit down the tenant tree; grants never do.
- **Custom DB tables live on their own Postgres schema**, with foreign keys back to Interchange's tenant/principal tables. Each package ships one idempotent migration, which the hub applies itself at boot. A custom table that gets deleted is hard-removed: delete the schema code, no drop migration. Cutovers are breaking; reset the database.
- **Core UI components live in [corbitsdev/react-ui](https://github.com/corbitsdev/react-ui).** Build reusable components there; only workbench-specific composition lives here.
- **This repo is public.** No secrets or credentials, ever — `.env.example` is the only tracked env file. Anything sensitive (client names, internal context, infra/deploy rulings) goes in Linear, not in commits, PRs, or docs.

## Interchange reference

Check these for a stock route or primitive before touching the hub, sidecars, or workflows. Links follow upstream main; the commit we run is the stock ref in [VENDORED.md](VENDORED.md).

- [LAYOUT.md](https://github.com/faremeter/interchange/blob/main/LAYOUT.md), [CONVENTIONS.md](https://github.com/faremeter/interchange/blob/main/CONVENTIONS.md): where things live and how upstream writes code
- [ARCHITECTURE.md](https://github.com/faremeter/interchange/blob/main/docs/ARCHITECTURE.md): hub, sidecar, and workflow run model
- [WORKFLOW_AUTHORING.md](https://github.com/faremeter/interchange/blob/main/docs/WORKFLOW_AUTHORING.md): how workflows are written
- [workflow-lifecycle-policy.md](https://github.com/faremeter/interchange/blob/main/docs/workflow-lifecycle-policy.md), [SIDECAR_PLACEMENT.md](https://github.com/faremeter/interchange/blob/main/docs/SIDECAR_PLACEMENT.md): lifetimes, capacity release, and where sidecars run
- [API.md](https://github.com/faremeter/interchange/blob/main/docs/API.md), [ROUTES.md](https://github.com/faremeter/interchange/blob/main/docs/ROUTES.md): the stock routes the web client and hub use
- [INBOUND_MAIL_POLICY.md](https://github.com/faremeter/interchange/blob/main/docs/INBOUND_MAIL_POLICY.md), [MESSAGE.md](https://github.com/faremeter/interchange/blob/main/docs/MESSAGE.md): mail routing behind the webhook and cron bridges
- [AUTH.md](https://github.com/faremeter/interchange/blob/main/docs/AUTH.md), [CREDENTIALS.md](https://github.com/faremeter/interchange/blob/main/docs/CREDENTIALS.md), [GIT_ACCESS.md](https://github.com/faremeter/interchange/blob/main/docs/GIT_ACCESS.md): sessions, the vault, and git tokens

## Code

- Match existing style. Every package under `packages/*` needs a `LICENSE` file (LGPL-2.1).
- Comments say why, when the code cannot; never what it does.
- `async`/`await` with `try`/`catch`; report every caught error through `reportError` from `@corbits/error-sink` — never a bare `catch {}`.
- Parse at every trust boundary: arktype schemas for env, request bodies, and external data; never `as T` untrusted input.
- No fallbacks. Cut over cleanly — never leave a legacy path beside a new one. Config/manifest objects are explicit literals; the one exception is an optional key under `exactOptionalPropertyTypes: true`, where `...(x !== undefined ? { k: x } : {})` is the only correct way to omit it rather than assigning `undefined`.
- A package's `browser-safe` subpath never imports a server-only dependency (`postgres`, `drizzle-orm`, `hono`, any `@intx/*`).
- A dependency declared in the root `catalog` is consumed as `catalog:`.
- Leave no dead code, unused exports, or aliases behind.

## Commits and pull requests

- Worktrees live in `.worktrees/<branch>`; branch = `cl-<issue#>-<slug>`.
- `bun run check` (typecheck, lint, fmt, test) must pass before every commit. There are no custom structural check scripts; a rule lives in the code or schema itself or it does not exist.
- Pull request titles and every commit subject must follow **Conventional Commits**: `type(scope): description` or `type: description` with an allowed type (`feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `ci`, `build`, `style`, `revert`) — enforced by `.corbits-triage.yml`.
- Commit sequence per change: tests first (`test(scope): add tests for X`), then implementation (`feat(scope): ...` or `fix(scope): ...`), then docs (`docs(scope): update docs for X`). One logical change per commit; commit messages are written for a public audience.
- Deployment mechanics are not settled enough to state here — see [IMPLEMENTATION.md](IMPLEMENTATION.md)'s Deployment section first.

## Tests

- Two homes only. A load-bearing unit test sits beside the module it covers (`src/**/*.test.ts`); a load-bearing integration or DB-backed suite lives under root `e2e/<area>/`, with shared helpers in `e2e/lib/`. No `test/` directory exists anywhere — not in apps, packages, agents, or tools.
- Meaningful red/green tests only — no coverage theater. A test that isn't load-bearing (pins a literal, a shape, a re-export, or re-proves Interchange's own behavior) is deleted, not moved. An outdated test is deleted in the same PR that breaks it, not adapted to keep passing; rebuilding coverage for the area it covered happens under CL-8150.
- Bun loads repo-root `.env`, so an unset test inherits `HUB_DATA_DIR=.data/hub` inside this work tree — the hub's git-on-disk init can then walk up to the enclosing `.git` and land a genesis commit on the working branch. Tests that boot the hub or touch seed/deploy git paths must call `installDisposableHubDataDir()` from `e2e/lib/disposable-hub-data-dir.ts`; never delete the `HUB_DATA_DIR` key.

Env flags (unset behavior):

| Flag                                                        | If unset                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                              | DB-gated suites skip locally; `CI=true` makes it a hard failure on jobs that provision Postgres |
| `HUB_DATA_DIR`                                              | hub boot fails — required runtime config                                                        |
| `CI`                                                        | set by GitHub Actions; not a caller flag                                                        |
| `E2E_PROVIDER` / `E2E_PROVIDER_API_KEY` / `OLLAMA_BASE_URL` | live-inference e2e stays on the noop/stub path                                                  |

## Docs

- Docs follow the change: a pull request that changes behavior, options, routes, or screens updates the affected `README.md` and docs in the same pull request, or says in its description why none needed a change.
- User docs say what a person sees and does, not how the code does it; mechanics belong in [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md).
- Map: [README.md](README.md) (quickstart and layout), [PRODUCT.md](PRODUCT.md) (what Workbench is), [ARCHITECTURE.md](ARCHITECTURE.md) (system structure), [IMPLEMENTATION.md](IMPLEMENTATION.md) (stack and deployment), [DESIGN.md](DESIGN.md) (visual canon), [VENDORED.md](VENDORED.md) (vendoring ledger), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/GLOSSARY.md](docs/GLOSSARY.md), [docs/local-dev.md](docs/local-dev.md).
