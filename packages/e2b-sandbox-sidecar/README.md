# @corbits/e2b-sandbox-sidecar

`SidecarProvisioner` backend that runs sidecar allocations as [E2B](https://e2b.dev)
sandboxes, plus the E2B image template that boots `apps/sidecar` inside one.

## What ships in the image

The template (`template/definition.ts`) builds the E2B image from this
repository's own tree — there is no sibling Interchange checkout. The build
context is staged on disk first (`template/build-context.ts`) as an explicit
allowlist:

- `apps/sidecar` — full source, the entrypoint (`src/index.ts`).
- The workspace packages `apps/sidecar` transitively depends on — full
  source (`packages/agent-lifecycle`, `packages/credential-providers`, and
  the vendored Interchange packages under `vendor/intx/*` it uses).
- Every other workspace member declared under the root `package.json`'s
  `workspaces` globs (`apps/*`, `packages/*`, `tools/*`, `vendor/intx/*`,
  `workflows/*`) — `package.json` only. This stub is required for
  `bun install --frozen-lockfile` to resolve the whole workspace graph
  (bun's lockfile enumerates every workspace member by path and fails
  otherwise); it never ships that package's source.
- The root `package.json` and `bun.lock`.
- `template/start-sidecar.ts`, copied to `/opt/interchange-e2b/` in the
  image — creates `SIDECAR_DATA_DIR`, then spawns the sidecar and forwards
  `SIGTERM`/`SIGINT`, propagating its exit code.

Vendored packages under `vendor/intx/*` are consumed as TypeScript source:
their `package.json#exports` already point at `./src/*` (see any
`vendor/intx/*/VENDORED-FROM`), so the image build does **not** pass
`--conditions=intx-src` — that upstream condition doesn't apply here.

**No tool packages are baked into the image.** Tools are materialized at
deploy time from registries via pins (`apps/sidecar/src/tool-materialization.ts`);
the image stays tool-agnostic.

### Excluded, by construction

The stager only ever reads the root manifest/lockfile and the five
workspace glob roots above — it never enumerates `.data/`, `.env*`,
`.worktrees/`, or `.git`, so nothing in them can reach the image regardless
of what a future contributor puts there. `template/build-context.test.ts`
asserts this directly against the real repository tree. The template's
`fileIgnorePatterns` repeat the exclusion as defense in depth, but the
allowlist staging step is what actually enforces it.

### Base image

Pinned to `oven/bun:1.3.9` (`fromBunImage("1.3.9")`) — an explicit patch
version, not `latest` or a bare major, so the image is reproducible across
builds and matches this workspace's `engines.bun` requirement and the Bun
version the lockfile was produced with.

## Building the template

```sh
E2B_API_KEY=e2b_... bun packages/e2b-sandbox-sidecar/template/build.ts
```

This runs `Template.build(...)` against the real E2B API — it needs a valid
`E2B_API_KEY` and creates real infrastructure. It is not exercised by
`bun test`. On success it prints the immutable template ID:

```
Built E2B template <name> (<templateId>)
E2B_TEMPLATE=<templateId>
```

Use the printed **template ID**, not the template name — the name is a
mutable alias and the provisioner's binding fingerprint must pin the exact
image. Set that ID as `E2B_TEMPLATE` for the provisioner (see
`src/config.ts`).

## Operator environment variables

Required by the provisioner (`readProvisionerConfig` in `src/config.ts`):

- `E2B_API_KEY` — E2B API key (`e2b_...`).
- `E2B_TEMPLATE` — the template ID printed by the build step above.
- `E2B_PROVISIONER_DATA_DIR` — absolute path for the provisioner's local
  state.
- `E2B_SANDBOX_TIMEOUT_MS` (optional) — sandbox lifetime, 60s–24h, defaults
  to 15 minutes.

Per-allocation, the provisioner passes `HUB_WS_URL`, `SIDECAR_ID`, and
`SIDECAR_TOKEN` into the sandbox's background launch command
(`src/e2b-backend.ts`).

**`HUB_WS_URL` must be a public `wss://` URL or tunnel.** An E2B sandbox is
a remote machine — it cannot reach a hub bound to `localhost` or a
private/dev-only network. Point it at a publicly reachable hub endpoint, or
a tunnel (e.g. an ngrok/Cloudflare tunnel) in front of a local hub.

## What is NOT verified here

Building and booting an actual E2B image needs a real `E2B_API_KEY` and
creates billable infrastructure, so this package's tests do not do it.
Unverified without E2B credentials:

- That `Template.build(...)` actually succeeds against the E2B API.
- That `bun install --frozen-lockfile` succeeds _inside_ the real E2B
  build environment (verified locally instead: `build-context.test.ts`
  stages the real repository tree and asserts every workspace member bun's
  lockfile expects is present with at least a `package.json`, which is the
  condition a local `bun install --frozen-lockfile` repro confirmed is
  sufficient).
- That the booted sandbox's `bun run /opt/interchange-e2b/start-sidecar.ts`
  successfully dials `HUB_WS_URL` and stays alive for the configured
  sandbox lifetime.
