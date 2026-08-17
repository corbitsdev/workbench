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

This is safe to re-run.

## Memory plane

The memory plane (embeddings-backed recall) needs `EMBED_BASE_URL` set;
without it, `apps/hub/src/memory-mount.ts` skips mounting the memory plane
and logs that it did, rather than failing hub startup.

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
