# Corbits Workbench

The multiplayer workspace for humans and AI agents. Workbench is a web
client of [Interchange](https://github.com/faremeter/interchange): it
signs you into a plain Interchange tenant, and chat is mail threads over
`@corbits/mailbox`. The one shipped agent, Myra, creates whatever
workflows, tools, or skills a job needs on the fly.

## Quickstart

Requires [Bun](https://bun.sh) >= 1.2 (pinned in `.bun-version`) and a
local [Postgres](https://www.postgresql.org) 17 with the pgvector
extension — `brew install postgresql@17 pgvector` on macOS, or bring up
the same Postgres CI uses: `docker compose -f compose.test.yml up -d`.

```sh
bun install
cp .env.example .env
bun run dev
```

`bun run dev` validates `.env`, applies pending migrations, builds the web
UI if needed, and starts the hub. It signs up a local administrator
(`HUB_ADMIN_EMAIL` / `HUB_ADMIN_PASSWORD`, default
`alice@example.com` / `password123`) through the same auth API the UI
uses — hub boot itself creates no users, tenants, or product data.

Required env vars (see `.env.example` for the full, commented list):
`DATABASE_URL`, `BASE_URL`, `SESSION_SECRET`, `HUB_DATA_DIR`,
`HUB_ALLOW_GIT_INSIDE_WORK_TREE`, `HUB_STATIC_DIR`. Everything else —
OAuth sign-in, the memory plane's embedding provider, sidecar
provisioners — is optional and documented inline in that file. To run
fully offline, connect the Ollama provider from the UI instead of a
cloud key; see [docs/local-dev.md](docs/local-dev.md).

To wipe local state (drops the schema and the hub's on-disk asset
directory, refuses against anything but a local database):

```sh
bun run reset
```

## Repo layout

| Path          | What lives here                                                |
| ------------- | --------------------------------------------------------------- |
| `apps/`       | `hub` (API), `web` (React client), `sidecar` (execution host)   |
| `packages/`   | Domain packages and Workbench-specific composition               |
| `tools/`      | Publishable `@corbits/*` agent-tool packages                      |
| `agents/`     | Publishable `@corbits/*` agent packages (`assistant` is Myra)     |
| `skills/`     | Publishable `@corbits/*` skill packages                           |
| `workflows/`  | Workflow definition packages, deployed as assets                  |
| `vendor/intx` | Hand-copied Interchange fallbacks; see [VENDORED.md](VENDORED.md) |

## Development

```sh
bun run check       # typecheck, lint, fmt:check, test — the full gate
bun run test:e2e    # end-to-end smoke tests against a scratch database
bun run fmt         # oxfmt write
```

`test` and `test:e2e` need a reachable `DATABASE_URL`; DB-gated suites
skip locally with a banner and fail loudly in CI.

More: [AGENTS.md](AGENTS.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[IMPLEMENTATION.md](IMPLEMENTATION.md), [PRODUCT.md](PRODUCT.md).

## License

The application (`apps/` and the rest of this repo) is GPLv2 with the
[AI Exception](GPLv2-AI-Exception.md) — see [LICENSE.md](LICENSE.md).
Libraries under `packages/`, `tools/`, `agents/`, `skills/`, and
`workflows/` are each licensed LGPL-2.1-or-later.
