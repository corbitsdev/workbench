# Running fully local (Ollama)

Workbench can run with no cloud LLM key at all, using a local
[Ollama](https://ollama.com) instance as the inference provider.

Set `OLLAMA_BASE_URL` in `.env` to the origin your Ollama instance listens
on (e.g. `http://localhost:11434`, or a tailscale-tunneled origin) —
`bun run dev`'s memory setup still reads it (it mounts the `@corbits/memory`
plane against the same origin when `EMBED_BASE_URL` is unset). The hub
itself no longer reads provider env vars at all: connect the Ollama
provider in the UI instead — its onboarding card is the one that asks for
a base URL instead of a token, and it needs no key.

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
`@corbits/tool-registry-publish`. Hub boot does not publish that registry
(or any other product state). `publishCorbitsToolsRegistry` packs onto a
tenant when onboarding or an explicit `@corbits/seeding` caller asks;
descendants inherit it, and `seedTenant` does not pack. After changing a
tool package's source, bump its version, then publish onto the tenant that
owns the registry — restarting the hub does not republish. The operator
path is `bun run publish-tools` (with `HUB_ADMIN_EMAIL`/`HUB_ADMIN_PASSWORD`
set, and `--tenant <id-or-slug>` when the admin belongs to more than one
tenant): it signs in, resolves the target tenant, and installs the
registry onto that already-existing tenant over the hub's native asset
routes. Resolution and the sidecar's materialized store key on
`name@version`, not on content, so republishing unchanged-version bytes
never reaches a running or freshly-launched agent; `tool-registry-publish`
refuses to overwrite an existing `name@version` with different content for
exactly this reason.

## Per-tenant desired-state reconciliation (CL-7584)

Every real tenant converges onto the tenant desired-state document
(`TENANT_DESIRED_STATE`, `packages/onboarding/src/desired-state.ts`) — a
plain client-side const composed by reference over `DEFAULT_WORKFLOWS`,
`REQUIRED_SEED_TOOL_PACKAGES`, and `DEFAULT_SKILLS`. It is not a hub
table and there is no migration; growing the core workflow set later is
an edit to the upstream constants, never a schema change.

`reconcileTenantDesiredState` is the one installer: it reads the
tenant's real state with native GETs only and installs ONLY the absent
pins — tool packages first (workspace-pack publish, or a verified
`tarball-url` fetch through `installRegistryTarball`; no external
artifacts exist yet, so the doc pins only workspace-pack this build),
then skills, grants, and workflows together through `seedTenant` with
`confirmDeployments: false`. Sidecar-unavailable (502-class) pins
report `blocked` without throwing; anything else reports `failed` and
is safe to re-run. With every pin present a reconcile pass is reads
only — `seedTenant` is never entered.

Convergence has three triggers, all driving the same reconciler:

1. A tenant-create observation: a 201 from `POST /api/tenants` fires a
   fire-and-forget reconcile under the creator's minted session
   (`apps/hub/src/tenant-create-onboard.ts`).
2. The pending-seed drain: `runOnce` delegates to the same reconcile;
   the `pending_seed` row stays the only durable work item (ready
   clears it, blocked keeps it, failed keeps it and backs off).
3. The revisit kick: `POST /api/onboarding/provision` fires a kick when
   the caller's tenant still has pending pins — how a joined member's
   bench converges.

`GET /api/onboarding/provisioning-status` carries the doc-derived
`steps` list the onboarding page renders; a ready answer collapses it.

## Memory plane

The memory plane (embeddings-backed recall) is `@corbits/memory`, mounted
by `apps/hub/src/memory-mount.ts`. An explicit `EMBED_BASE_URL` wins;
otherwise `OLLAMA_BASE_URL` is a local embed path, and `bun run dev`
injects the native-Ollama embed env when Ollama is on PATH and neither
variable is set. Without any of those, the hub skips mounting the plane
and logs that it did, rather than failing hub startup — and
`memory_search`/`memory_add`/`memory_list` answer with a plain "memory
isn't set up on this server yet" note instead of erroring.

Run `bun run scripts/setup-memory.ts` (or `bun run setup:memory`) for a
recommendation tailored to this machine — it checks for native Ollama and
Docker, prints the exact env lines and commands, and writes missing
`EMBED_*` keys into `.env` when a local embed path exists:

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

- **No embedding configured (`EMBED_BASE_URL` and `OLLAMA_BASE_URL`
  unset, and no native Ollama for `bun run dev` to inject):** memory
  tools reply with a "not set up" note; search finds nothing. Setting
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
