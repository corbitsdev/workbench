# Corbits Workbench

**The multiplayer workspace for humans and agents.**

Corbits Workbench is the open-source workspace where your team and your AI
agents work side by side — same threads, same workflows, same inbox. Built on
[Interchange](https://github.com/faremeter/interchange), grounded in your
team's own knowledge, with every external side effect behind human approval.

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
[Postgres](https://www.postgresql.org) with the pgvector extension. On macOS:

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
actually speaks Postgres, and starts the hub and one sidecar together. Every
required setting lives in `.env.example` with its expected shape.

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
