# Running fully local (Ollama)

Workbench can run with no cloud LLM key at all, using a local
[Ollama](https://ollama.com) instance as the inference provider.

Set `OLLAMA_BASE_URL` in `.env` to the origin your Ollama instance listens
on (e.g. `http://localhost:11434`, or a tailscale-tunneled origin) — see
`apps/hub/src/config.ts`. Unlike every other provider, Ollama needs no key:
its mere presence auto-plants a probed catalog credential on the operator
bench at hub start. Each provider gets its own URL/key card in onboarding;
Ollama's is the one that asks for a base URL instead of a token.

Tool-heavy turns (anything that calls `mcp_list_tools`, dispatches a task,
or chains several tool calls) take noticeably longer — minutes, not
seconds — on small local models. This is a model-capability limit, not a
platform bug; expect it when testing against a small Ollama model.

## Migrations after pulling

`bun run dev` applies both the platform's own migrations and every
installed package's migrations at startup (`scripts/db-setup.ts`), reporting
what it applied. After pulling changes that add a migration, just restart:

```sh
bun run dev
```

No separate migrate command is needed — `dev` is safe to re-run and only
applies what hasn't already run.

## Republishing a tool package

A workflow that pins a `@corbits/*` tool package (e.g. **assistant** pinning
`@corbits/memory-tools`) resolves that pin from a `package-registry` asset
(`CORBITS_TOOLS_REGISTRY`) carrying the package's tarball, built by
`@corbits/tool-registry-publish`. `bun run seed` (`packages/hub-client/src/seed.ts`)
republishes that tarball every time it runs, so after changing a tool
package's source, republish and redeploy with:

```sh
bun run seed
```

This is safe to re-run. Changing a tool package's source requires bumping
its `package.json` `version` (and any pin naming that version) before
republishing — resolution and the sidecar's materialized store key on
`name@version`, not on content, so republishing unchanged-version bytes
never reaches a running or freshly-launched agent; `tool-registry-publish`
refuses to overwrite an existing `name@version` with different content for
exactly this reason.

## Memory plane

The memory plane (`@corbits/memory`, composed at `apps/hub/src/memory-mount.ts`,
`memory-config.ts`, and `memory-status.ts`) mounts at hub boot — config
and migrations both resolve then, not on first request. `GET
/api/tenants/:tenantId/memory/status` reports what the process currently
has and how to change it.

Config is env-only — deployment infrastructure, one per process, never
per-tenant and never from a connected credential:

1. `EMBED_BASE_URL`/`EMBED_MODEL` (see `.env.example`) — one embed
   endpoint for the whole deploy.
2. Otherwise, lexical-only: full-text search only, no embed endpoint.
   This needs nothing beyond a pgvector-capable Postgres and is a fully-
   supported mode, not a degraded one — every tenant always has at least
   lexical search.

Data SCOPE is a separate axis from config, and is resolved per request,
automatically: every caller's tenant is walked up to its bench/account
tenant (`packages/memory-hub/src/account-tenant.ts`'s
`resolveAccountTenantId`, via `@corbits/memory`'s `CallerResolver` seam),
so a caller in a workbench and the same caller in the bench itself always
reach the same memory, two different accounts never collide, and the walk
never ascends into an operator tenant (which would merge every account's
memory into one store). `packages/memory-hub`'s workflow-run routes apply
the same remap, so an agent running in a workbench reads and writes the
exact memory its human teammates do there.

## Isolated capacity (exclusive per-workbench sidecars)

Set `SIDECAR_PROVISIONER=docker` and `DOCKER_PROVISIONER_IMAGE` (see
`.env.example`) to register `@corbits/docker-provisioner` at hub start. This
flips the Workbench Settings › Capacity toggle from "not available on this
server" to available, and lets a tenant's "run this workbench on its own
sidecar" setting provision a real Docker container per exclusive allocation
via the vendored sidecar-allocation subsystem — no additional orchestration
needed on top of what's already wired in `apps/hub/src/index.ts`.

`DOCKER_PROVISIONER_IMAGE` must point at a built image of `apps/sidecar`
that the local `docker` CLI can run. Build one from the repo root (the
build context has to be the repo root, not `apps/sidecar`, because the
workspace's `@intx/*`/`@corbits/*` deps are `workspace:*` and resolve from
source):

```sh
bun run build:sidecar-image
```

Then point the provisioner at it and flip the toggle:

```sh
DOCKER_PROVISIONER_IMAGE=corbits-sidecar:dev
SIDECAR_PROVISIONER=docker
```

Restart `bun run dev` after setting these, then enable the Workbench
Settings › Capacity toggle to provision an exclusive per-workbench sidecar.
