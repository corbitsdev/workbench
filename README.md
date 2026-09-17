# Corbits Workbench

A multiplayer workspace where people and AI agents share the same threads.
Workbench is a web client for [Interchange](https://github.com/faremeter/interchange):
you sign in to a plain Interchange tenant, chat is mail, and Myra, the one
shipped agent, builds whatever workflows, tools, or skills a job needs.

## Run it

Needs [Bun](https://bun.sh) (version in `.bun-version`) and Postgres 17
with pgvector. `docker compose -f compose.test.yml up -d` gives you the
same Postgres CI uses.

```sh
bun install
cp .env.example .env
bun run dev
```

`bun run dev` starts the hub and the web dev server, applies migrations,
and signs up a local admin (`alice@example.com` / `password123` unless
`HUB_ADMIN_EMAIL` / `HUB_ADMIN_PASSWORD` are set). Connect an inference
provider from the UI; keys are never read from the environment.

`bun run reset` wipes local state. It refuses anything but a local database.

## Layout

| Path          | Contents                                                         |
| ------------- | ---------------------------------------------------------------- |
| `apps/`       | `hub` (API), `web` (React client), `sidecar` (execution host)    |
| `packages/`   | Corbits libraries                                                |
| `tools/`      | `@corbits/*` agent tool packages                                 |
| `agents/`     | `@corbits/assistant` (Myra)                                      |
| `skills/`     | `@corbits/*` skill packages                                      |
| `vendor/intx` | Hand-copied Interchange packages, see [VENDORED.md](VENDORED.md) |

## Develop

```sh
bun run check      # typecheck, lint, fmt:check, test
bun run test:e2e   # end-to-end suites, need DATABASE_URL
```

Conventions live in [AGENTS.md](AGENTS.md).

## License

The application is GPLv2 with the [AI Exception](GPLv2-AI-Exception.md);
see [LICENSE.md](LICENSE.md). Libraries under `packages/`, `tools/`,
`agents/`, and `skills/` are LGPL-2.1.
