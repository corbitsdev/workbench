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
shape, and a development account is seeded so you can sign in immediately.

## Repo layout

| Path         | What lives here                                            |
| ------------ | ---------------------------------------------------------- |
| `apps/`      | Deployable services (hub API, web UI, Interchange sidecar) |
| `packages/`  | Domain packages — all product logic lives here             |
| `workflows/` | Workflow definition packages, deployed as assets           |

## Development

- `bun run check` — the full gate: typecheck, lint, test
- `bun run test` — workspace tests
- `bun run format` — prettier write

Conventions and agent guidance: [AGENTS.md](AGENTS.md). Contributions:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPLv2 with the [AI Exception](GPLv2-AI-Exception.md) — see
[LICENSE.md](LICENSE.md).
