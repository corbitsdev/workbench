# @corbits/tool-registry-publish

Packs a `@corbits/*-tools` package into a self-contained npm-style
tarball (every dependency inlined, so the tarball declares no
`dependencies` at all) and publishes it into a tenant's `corbits-tools`
`package-registry` asset over the hub's native asset REST routes —
the packaging pipeline `@corbits/*` tool-package pins need to resolve
at agent launch (see `vendor/intx/hub-sessions/src/package-registry-kind.ts`
for the asset's shape and `vendor/intx/tool-packaging/src/loader.ts`
for how a pin resolves through it).

## Contract

**Owns:**

- `CORBITS_TOOLS_REGISTRY` — the one literal naming the registry asset;
  `apps/hub`'s scope-routing config imports this constant rather than
  repeating the string.
- `CORBITS_TOOL_PACKAGE_DIRS` — the list of `packages/*-tools`
  directories this publisher packs and pushes. A package whose pin has
  no entry here fails the closure resolver with "unknown registry" at
  launch; registering it here is the fix.
- `packToolPackageTarball` — reads a package directory's
  `package.json`, bundles its `"."` export with the `bun build` CLI
  (an isolated subprocess — an in-process `Bun.build()` call was
  observed to fail nondeterministically alongside other live `bun`
  processes), and tars the result. Memoized per directory for a
  process's lifetime, so concurrent or repeated calls never race two
  bundler invocations against the same input.
- `publishCorbitsToolsRegistry` — find-or-create the tenant's
  `corbits-tools` asset (409-tolerant, so two overlapping seed runs
  for the same tenant never both fail on the asset's own name
  collision), then `PUT` every tarball `CORBITS_TOOL_PACKAGE_DIRS`
  produces.

**A host injects:**

- `api` (an `ApiCall`: `(method, path, body?, cookies?) => Promise<{status, data, cookies}>`),
  `cookies`, and `hubUrl` — this package issues no request without
  them and holds no session or authentication state of its own.
- `tenantId` — which tenant's registry asset to publish into; this
  package has no notion of "the" tenant.
- `log` — a plain `(line: string) => void` sink for progress lines.
- `fetchImpl` (optional) — the raw `fetch` the tarball `PUT` uses,
  defaulting to the global `fetch`; a caller substitutes it the same
  way it would substitute `api`.

**Never imports:**

- `@workbench/hub-client` — the dependency direction runs the other
  way (`hub-client`'s `seedTenant` calls `publishCorbitsToolsRegistry`),
  so this package declares its own structurally-compatible `ApiCall`
  type rather than importing `hub-client`'s.
- `CliError` or any operator-facing error-wrapping convention — every
  failure here is a plain `Error`; wrapping it as an actionable
  `CliError` (problem + fix) is the calling seed step's job, not this
  package's.
- Any workflow definition or `DEFAULT_WORKFLOWS` — this package knows
  which tool packages to publish, never which workflows pin them.

## Running tests

```sh
cd packages/tool-registry-publish && bun test
```

Tests exercise `packToolPackageTarball` against real package directories
under `packages/*-tools`; no `DATABASE_URL` is required.
