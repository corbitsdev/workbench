# Implementation

The concrete stack behind [ARCHITECTURE.md](ARCHITECTURE.md)'s structure
and [PRODUCT.md](PRODUCT.md)'s surface.

## Runtime and language

- **[Bun](https://bun.sh)** >= 1.2 — package manager, task runner, and test
  runner across the whole workspace.
- **TypeScript** — the implementation language throughout `apps/`,
  `packages/`, and `workflows/`.
- **[Hono](https://hono.dev)** — the HTTP framework the hub and its mounted
  package routers use.
- **[Vite](https://vitejs.dev)** — builds the web app.

## Data

- **Postgres** (17, with the **pgvector** extension) — the platform
  database, reached through `DATABASE_URL`.
- **[Drizzle](https://orm.drizzle.team)** — the ORM/query layer, both in
  vendored `@intx/db` and in workbench-owned packages that need their own
  tables (e.g. `packages/chat`'s `chat` schema, `packages/skills`'s
  `skills.skill_access`).
- Package-owned migrations run through each package's own migration
  runner; see [docs/package-migrations.md](docs/package-migrations.md).

## Trust boundaries

**[arktype](https://arktype.io)** schemas validate every request body, env
value, and piece of external data at the point it crosses into the system
— never an `as T` cast on untrusted input. `.env` validation at `bun run
dev` startup reports every missing or malformed value at once, using the
same discipline.

## UI

**[@corbits/react-ui](https://github.com/corbitsdev/react-ui)** is the
shared component library workbench consumes rather than reimplementing —
core, reusable components live there; only workbench-specific composition
(the shell, page layout, feature-specific screens) lives in this repo. It
is pinned to a specific upstream commit rather than a floating version
range.

## Vendored `@intx/*`

Interchange capabilities are consumed as published `@intx/*` npm packages
wherever a publish covers what's needed. Where a capability is not yet
published, it is vendored — hand-copied into `vendor/intx/<package>`, one
row per path in [VENDORED.md](VENDORED.md), the authoritative ledger. Each
row carries the upstream commit it was copied from, why it isn't a
published package yet, an owner, a **kill date**, and a dated test
(`check:killdates`) that starts failing after that date — forcing either a
re-pin to a fresher upstream commit or a cutover to the published package.
Vendoring is hand-copied files only, never a git submodule; the upstream
repository is never modified. Local modifications to vendored code (e.g.
repointing an export map from `intx-src` resolve conditions to direct
TypeScript source, since workbench forbids custom resolve conditions) are
recorded per-package in each vendored package's own `VENDORED-FROM` file.

## Commands

| Command            | What it does                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `bun run dev`      | Validates `.env`, verifies the database, applies pending migrations, builds the web UI if needed, starts the hub and one sidecar |
| `bun run setup`    | Provisions the bench for the administrator account                                                                               |
| `bun run seed`     | Deploys the default workflow set and plants the tenant catalog's model data                                                      |
| `bun run reset`    | Drops the platform database schema and clears on-disk asset directories (local `DATABASE_URL` only, unrecoverable)               |
| `bun run check`    | The full gate: `typecheck && lint && test` — must pass before every commit                                                       |
| `bun run test`     | Workspace unit/integration tests                                                                                                 |
| `bun run test:e2e` | End-to-end smoke tests (`scripts/e2e/*.test.ts`)                                                                                 |
| `bun run format`   | `prettier --write .`                                                                                                             |

`bun run dev` seeds only the administrator account; `setup` and `seed` are
run separately against the running stack and are safe to re-run.
`ANTHROPIC_API_KEY` is the one optional variable worth setting before
`bun run seed` — without it, everything still runs, but inference errors
until a key is set and seeding is re-run.

## Acceptance mechanism: the e2e browser walkthrough

`bun run test:e2e` is the acceptance bar for a working system, not just
unit coverage. Each file in `scripts/e2e/` spawns a real hub process
(some also spawn a real sidecar) against a scratch database and drives it
entirely through its own HTTP API — no mocking inside the process under
test. The `smoke-*.test.ts` suite covers, one scenario per file: sign-up
authorization, onboarding provisioning, a full chat round-trip (create,
post, read, invite), an artifact upload-and-retrieve round-trip, and a
signed webhook delivery launching a real run.

Each suite owns and rebuilds its own `<database>_e2e` sibling database on
every run, so it can never touch a developer's working database. The
suite needs zero real credentials: `startHub` only forwards an explicit
env allowlist, so a real `ANTHROPIC_API_KEY` in the shell never reaches
the spawned hub, and every inference source in a test points at the hub's
own `noop-inference` endpoint or an unreachable placeholder host —
enforced by `assertNeverRealProvider` in `scripts/e2e/harness.ts`. CI sets
`E2E_REQUIRED=1` so a missing `DATABASE_URL` fails loudly there instead of
silently skipping.

## Deployment

Deployment is explicit via **Pulumi**, targeting **Railway**. CI runs
tests only — nothing auto-deploys on `main`; a deploy is a deliberate,
separate action.

## GitHub connect (shipped)

The in-room `connect-github` card and the Plugins/Connections GitHub row
are **PAT-first** (CL-6345): the person pastes a personal access token;
the host tests and stores it through `@workbench/connections`' generic
`github/complete` route. The card then flips in place to pick repos
(`startReviewingRepos`). A GitHub App / hosted OAuth welcome mat is
CL-6343 and is not the current product path — do not document OAuth as
the first Connect step, and do not treat a PAT paste as a defect against
an OAuth-first welcome mat that has not shipped.

Optional `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` exist for
that future hosted path; leaving them unset is normal. See
`docs/connect-cards.md` and PRODUCT.md's Code review first minute.

## Related docs

- [README.md](README.md) — quickstart, local setup, repo layout, e2e detail
- [AGENTS.md](AGENTS.md) — working conventions, commit sequencing, coverage
  floor
- [VENDORED.md](VENDORED.md) — the vendoring ledger
- [docs/package-migrations.md](docs/package-migrations.md) — how a
  package's own migrations run
- [docs/model-seeding.md](docs/model-seeding.md) — how the catalog seed
  data is curated

## Open questions

- The single-command install path mentioned in README.md ("Workbench will
  install and run with a single command... does not exist yet") is not
  yet built; source checkout remains the only supported path as of this
  writing.
- Whether Pulumi stacks/config live in this repo or a separate
  infrastructure repo is not established in the docs reviewed for this
  pass.
