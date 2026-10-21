# Corbits Workbench

A multiplayer workspace where people and AI agents share the same threads.
Workbench is a web client for [Interchange](https://github.com/faremeter/interchange):
you sign in to a plain Interchange tenant, converse in workbenches, and each workbench's own
worker builds whatever workflows, tools, or skills a job needs.

## Run it

### Docker Compose

Run Postgres 17 (with `pgvector`) and the hub (serving the web client on port 3000) in containers:

```sh
cp .env.example .env   # set the encryption keys outside a laptop: openssl rand -hex 32 each
docker compose up --build -d
docker compose logs -f hub
```

Open `http://localhost:3000`. For cloud deployment, environment variables, and backups, see [docs/SELF_HOST.md](docs/SELF_HOST.md).

### Local development

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
`HUB_ADMIN_EMAIL` / `HUB_ADMIN_PASSWORD` are set). The first sign-in asks
for one inference provider; keys are never read from the environment. A
local [Ollama](https://ollama.com) works with no key, see
[docs/local-dev.md](docs/local-dev.md).

`bun run reset` wipes local state. It refuses anything but a local database.

## Layout

| Path          | Contents                                                         |
| ------------- | ---------------------------------------------------------------- |
| `apps/`       | `hub` (API), `web` (React client), `sidecar` (execution host)    |
| `packages/`   | Corbits libraries, and `worker`, the default agent harness       |
| `workflows/`  | Deployable workflow packages                                     |
| `vendor/intx` | Hand-copied Interchange packages, see [VENDORED.md](VENDORED.md) |

## Develop

```sh
bun run check      # typecheck, lint, fmt:check, test
bun run test:e2e   # end-to-end suites, need DATABASE_URL
```

## Read next

- [PRODUCT.md](PRODUCT.md): what a workbench, its worker, tools, and skills are.
- [docs/SELF_HOST.md](docs/SELF_HOST.md): self-hosting with Docker Compose or any container host.
- [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md): how the hub, sidecar, and web client are built.
- [docs/local-dev.md](docs/local-dev.md): running locally with Ollama, memory embeddings, and OAuth providers.
- [docs/GLOSSARY.md](docs/GLOSSARY.md): product-term to platform-term mapping.
- [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md), and [DESIGN.md](DESIGN.md): contributing, code rules, and the visual design system.

## License

The application is GPLv2 with the [AI Exception](GPLv2-AI-Exception.md);
see [LICENSE.md](LICENSE.md). Libraries under `packages/` are LGPL-2.1. Contributions require the [CLA](CLA.md); see [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues per [SECURITY.md](SECURITY.md).
