# Corbits Workbench

**The multiplayer workspace for humans and agents.**

Corbits Workbench is the open-source workspace where your team and your AI
agents work side by side in shared [benches](docs/GLOSSARY.md) — same
threads, same workflows, same inbox. It is the default implementation of
the Corbits Platform — a set of pluggable libraries with
[Interchange](https://github.com/faremeter/interchange) at the core —
offering agents, workflows, and multi-tenant capabilities for organizations
embracing agentic solutions. Grounded in your team's own knowledge, with
every external side effect behind human approval.

## Install

Workbench will install and run with a single command. That command does not
exist yet — until it does, work from a source checkout as described below.

## Quickstart

Requires [Bun](https://bun.sh) >= 1.2.

```sh
bun install
bun run typecheck && bun run lint && bun run test
```

## Running locally

Requires [Bun](https://bun.sh) >= 1.2 and a local
[Postgres](https://www.postgresql.org) with the pgvector extension — any
Postgres 17 you point `DATABASE_URL` at works. On macOS:

```sh
brew install postgresql@17 pgvector
brew services start postgresql@17
```

Then:

```sh
cp .env.example .env
bun run dev
```

`bun run dev` validates your `.env` (reporting every missing or malformed
value at once), verifies the database in `DATABASE_URL` is reachable and
actually speaks Postgres, applies any pending platform migrations, builds
the web UI if it has not been built yet, and starts the hub and one sidecar
together. Every required setting lives in `.env.example` with its expected
shape, and the administrator account (`HUB_ADMIN_EMAIL` / `HUB_ADMIN_PASSWORD`,
defaulting to alice@example.com / password123 when unset)
is seeded so you can sign in immediately.

`bun run dev` only seeds that account — it provisions no bench, catalog, or
workflows. Once the stack is up, run these against it (in another terminal):

```sh
bun run setup
bun run seed
```

`bun run setup` provisions the bench for the administrator account; `bun run
seed` deploys the default workflow set and plants the tenant catalog's model
data, so interactive instances have a model to resolve against. Both read
their configuration from `.env` (see `.env.example`) and are safe to re-run.
`ANTHROPIC_API_KEY` is the one optional line worth setting before you run
`bun run seed` — with it, seeding plants a real credential and the catalog
is actually launchable; without it, everything above still runs, but
inference errors until you set it and re-run `bun run seed`.

Leaving `ANTHROPIC_API_KEY` unset doesn't just apply to the administrator
account: anyone who signs up gets a personal bench with no default routines
deployed, and first-run tells them exactly that. Onboarding walks them
through picking a provider — Anthropic, OpenAI, Google, OpenRouter, Hugging
Face, Groq, or another of the curated providers in
[`packages/hub-client/src/catalog-seed-data.ts`](packages/hub-client/src/catalog-seed-data.ts)
— and pasting their own key (or, for OpenRouter, completing a PKCE OAuth
connect), proves it with a real call before storing anything, then deploys
and confirms the default routines on the spot — no separate `bun run seed`
step, no docs to read. Whichever provider they connect gets its own curated
catalog entry planted the same way `bun run seed` plants Anthropic's; see
[docs/model-seeding.md](docs/model-seeding.md) for how that catalog data is
curated and kept up to date.

### Resetting local state

To test onboarding (the self-serve signup and first-login provisioning flow)
from a clean slate, or to recover from a broken local database, run:

```sh
bun run reset
```

`bun run reset` drops the platform database schema and removes the hub's
and the dev sidecar's on-disk asset directories — everything `bun run setup`
and `bun run seed` created, plus anything provisioned through onboarding.
Nothing is re-seeded: the next `bun run dev` recreates the schema from
scratch and starts you at a fresh sign-up screen. Run `bun run setup && bun
run seed` afterward instead if you want a reprovisioned bench rather than a
blank slate.

It refuses to run against anything but a local `DATABASE_URL` (localhost,
127.0.0.1, or `::1`) — there is no override, since the schema drop is
unrecoverable.

### OAuth sign-in

Email/password sign-in always works. To let people sign in with an
existing Google or GitHub account instead, set that provider's client id
and secret in `.env` — `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and/or
`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, each an independent pair. The
matching button then appears on the sign-in screen automatically; leave
both values of a pair unset to leave that provider off. Setting only one
value of a pair is a boot-time error — the hub refuses to start rather than
silently disable the provider. See `.env.example` for where to register
each OAuth app and what redirect URI to configure.

## Repo layout

| Path         | What lives here                                            |
| ------------ | ---------------------------------------------------------- |
| `apps/`      | Deployable services (hub API, web UI, Interchange sidecar) |
| `packages/`  | Domain packages — all product logic lives here             |
| `workflows/` | Workflow definition packages, deployed as assets           |

Chat — the shared conversation surface humans and agents both use — is
documented separately in [docs/CHAT.md](docs/CHAT.md).

## Development

- `bun run check` — the full gate: typecheck, lint, test
- `bun run test` — workspace tests
- `bun run test:e2e` — end-to-end smoke tests (see below)
- `bun run format` — prettier write

Conventions and agent guidance: [AGENTS.md](AGENTS.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).

### End-to-end smoke tests

`bun run test:e2e` runs `scripts/e2e/*.test.ts`: each file spawns a real hub
process (some also spawn a real sidecar) against a scratch database and
drives it entirely through its own HTTP API — no mocking inside the
process under test. `scripts/e2e/smoke-*.test.ts` are the CL-6004 smoke
suite, one scenario per file, each independent and safe to run alone or
in any order:

| File                       | Proves                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `smoke-auth.test.ts`       | Email sign-up mints a session cookie that authorizes a session-gated route                                          |
| `smoke-onboarding.test.ts` | `POST /api/onboarding/provision` mints a personal bench and reports it unseeded when no seed model is configured    |
| `smoke-chat.test.ts`       | A channel is created, a message posts and reads back intact, and the invited-agent listing has its documented shape |
| `smoke-library.test.ts`    | An artifact uploads through the multipart route and round-trips through list and get-by-id                          |
| `smoke-webhook.test.ts`    | A signed delivery to the public webhook ingress route launches a real run for a routine bound to that trigger       |

**Needs:** a reachable Postgres named by `DATABASE_URL` in `.env` (see
[Running locally](#running-locally)). Each suite reuses a sibling
`<database>_e2e` database that it owns outright — drops and rebuilds its
own schema on every run — so it can never touch your working database.
Without `DATABASE_URL` the suite skips with a warning; CI sets
`E2E_REQUIRED=1` so that skip fails loudly there instead of silently
passing.

**Needs zero real credentials.** The whole suite — smoke and non-smoke
files alike — runs with no API keys, no paid credentials, and no network
call to a real inference provider: `startHub` only forwards an explicit
env allowlist, so a real `ANTHROPIC_API_KEY` sitting in your shell never
reaches the spawned hub, and every inference source a test configures
points at the hub's own `noop-inference` endpoint or an unreachable
placeholder host. `scripts/e2e/harness.ts` exports
`assertNeverRealProvider` for any test that builds a baseURL/apiKey by
hand, so an accidental live-provider reference fails loudly instead of
attempting a real network call. Never document "set a key to run this" —
if a scenario would need one, stop at the keyless contract it can still
prove (see `smoke-onboarding.test.ts`) or don't write that scenario.

Run one file directly with `bun test scripts/e2e/smoke-auth.test.ts`
(`DATABASE_URL` still required).

## License

The application (`apps/` and the rest of this repo) is GPLv2 with the
[AI Exception](GPLv2-AI-Exception.md) — see [LICENSE.md](LICENSE.md).
Libraries under `packages/` and `workflows/` are each licensed
LGPL-2.1-or-later, with the license text alongside their source.
