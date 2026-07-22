# Workbench

**A horizontal agentic workspace — AI teammates working your team's own evidence, with every external side effect behind human approval.**

Workbench gives your team a personal agent (Myra), shared workbench agents (Oat and others), and workflows that turn raw sources — call recordings, docs, threads — into publishable artifacts. It is built on [Interchange](interchange/), which provides agent identity, credentials, and the runtime. GTM is the first workflow pack, not the identity — see [`docs/POSITIONING.md`](docs/POSITIONING.md).

## Quickstart

[Bun](https://bun.sh) 1.2+, Docker, and Git required.

```bash
git submodule update --init   # initialize the Interchange submodule
bun install                   # install workspace dependencies
docker compose up -d          # start PostgreSQL on localhost:5433
cp .env.example .env          # copy env and fill in required values
bun run dev                   # start hub + web + sidecar dev servers
```

The hub serves on `http://localhost:4000`, the web UI on `http://localhost:5174`. Full setup — env vars, database, seeding, running services individually — is in [`DEV.md`](DEV.md).

## How it works

Three services build from one Bun workspace (the repo root is the shared Docker build context for all of them):

```
        ┌──────────────┐        ┌──────────────┐
  you → │  web (SPA)   │ ─────▶ │  hub (API)   │  Hono · Drizzle · PostgreSQL
        │  React/Vite  │        │  control     │  auth, workflows, persistence
        └──────────────┘        │  plane       │
                                └──────┬───────┘
                                       │ WebSocket
                                ┌──────▼───────┐
                                │  sidecar     │  Interchange runtime —
                                │  agent host  │  agent lifecycle, tools
                                └──────────────┘
```

Agents, credentials, sessions, and inference all run through **Interchange** — Workbench never reimplements those. Domain knowledge (workflow definitions, prompts, artifact kinds, business rules) lives in `packages/*`; the apps are thin hosts that wire routes and render UI.

## Start here

| You want to…                                 | Read                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| Understand the product                       | [`docs/PRODUCT.md`](docs/PRODUCT.md) (canonical) · [`PRODUCT.md`](PRODUCT.md) |
| Run it locally / test / add a tool or agent  | [`DEV.md`](DEV.md)                                                            |
| Deploy it                                    | [`DEPLOY.md`](DEPLOY.md)                                                      |
| Write code here (conventions, testing rules) | [`AGENTS.md`](AGENTS.md)                                                      |
| Navigate the full doc set                    | [`docs/README.md`](docs/README.md)                                            |

## Stack

- **Runtime**: Bun 1.2+, TypeScript (strict)
- **Backend**: Hono, Drizzle ORM, PostgreSQL (port 5433)
- **Frontend**: React 19, Vite, Tailwind CSS, Framer Motion
- **Agent runtime**: `@intx/agent` (Interchange)

## Testing & deployment

The test workflow, coverage commands, and how the merged coverage number is computed live in [`DEV.md`](DEV.md#testing--coverage). The enforced **80% merged line coverage floor** is the value `coverage:report` checks (`COVERAGE_THRESHOLD=80`); the testing philosophy behind it is in [`AGENTS.md`](AGENTS.md). Deployment (Railway reference plus other providers) is in [`DEPLOY.md`](DEPLOY.md).
