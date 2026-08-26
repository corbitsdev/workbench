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
`@corbits/tool-registry-publish`. `workbench setup` publishes that tarball
onto the root tenant (descendants inherit it); `workbench seed` does not
pack. After changing a tool package's source, bump its version, then
republish with:

```sh
workbench setup
```

This is safe to re-run. Changing a tool package's source requires bumping
its `package.json` `version` (and any pin naming that version) before
republishing — resolution and the sidecar's materialized store key on
`name@version`, not on content, so republishing unchanged-version bytes
never reaches a running or freshly-launched agent; `tool-registry-publish`
refuses to overwrite an existing `name@version` with different content for
exactly this reason.

## Memory plane

The memory plane (embeddings-backed recall) needs `EMBED_BASE_URL` set;
without it, `apps/hub/src/memory-mount.ts` skips mounting the memory plane
and logs that it did, rather than failing hub startup — and
`memory_search`/`memory_add`/`memory_list` answer with a plain "memory
isn't set up on this server yet" note instead of erroring.

Run `bun run scripts/setup-memory.ts` (or `bun run setup:memory`) for a
recommendation tailored to this machine — it checks for native Ollama and
Docker and prints the exact env lines and commands for whichever it finds,
in the order the platform prefers them:

1. **Native first.** A local `ollama pull nomic-embed-text` needs no
   container and is the preferred embedding path.
2. **Docker** for the pieces with no good native story — the reranker
   (`ghcr.io/huggingface/text-embeddings-inference:cpu-latest`, serving
   `BAAI/bge-reranker-base`) and Gotenberg PDF rendering
   (`gotenberg/gotenberg:8`) — and as a fallback for embedding when native
   Ollama isn't installed.
3. **A remote endpoint**, always available as a third option — including
   an existing Ollama, TEI, or Gotenberg instance running elsewhere (the
   owner's own Tailscale-tunneled Ollama box is a first-class example, not
   a fallback of last resort).

Two things degrade on purpose rather than failing loudly, and both are
worth knowing before you rely on either:

- **No embedding configured (`EMBED_BASE_URL` unset):** memory tools reply
  with a "not set up" note; search finds nothing. Setting
  `EMBED_BASE_URL` later does **not** retroactively embed anything written
  while it was unset — migrations create the memory plane's tables either
  way, but there is no automatic backfill.
- **No reranker configured (`RERANK_BASE_URL`/`RERANK_MODEL` unset, or a
  configured reranker failing at request time):** search still works,
  just ordered by vector/full-text fusion alone rather than a
  cross-encoder pass — a reranker outage degrades search quietly rather
  than breaking it. Setting only one of `RERANK_BASE_URL`/`RERANK_MODEL`
  is a boot-time error, not a silently half-enabled reranker.

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
