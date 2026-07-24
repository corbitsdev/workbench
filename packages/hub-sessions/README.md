# @workbench/hub-sessions

Vendored copy of `@intx/hub-sessions` (`interchange/packages/hub-sessions`).
See [`docs/VENDORED.md`](../../docs/VENDORED.md) for the vendoring
discipline this repo follows and the full WORKBENCH-LOCAL inventory for
this package.

Session-orchestration substrate for the hub. Owns the sidecar
WebSocket router, the session service that provisions and tears
down agent sessions, the agent repository store, the event
collector registry, the asset service, and the skill kind handler.

Sits between `@intx/hub-api` (HTTP surface) and `@workbench/hub-agent`
(sidecar orchestrator): HTTP routes call into the session service
to start an agent, the session service drives the sidecar router
to provision it on the connected sidecar, and event collectors
feed agent events back to the HTTP layer for observability.

`createSessionService` takes a `SessionServiceDeps` of
`sidecarRouter`, `agentRepoStore`, and an optional
`assetService` paired with a `db` handle for the asset manifest
inserts. `createHubSessionOrchestrator` takes a
`HubSessionOrchestratorDeps` of `events`, `router`, `db`,
`eventCollectors`, and `agentRepoStore`. See the
exported types in `src/session-service.ts` and
`src/hub-session-orchestrator.ts` for the authoritative shapes;
`@intx/hub-api` is the in-tree consumer that wires these
factories together.

The package does not host HTTP routes itself; it exposes the
factories `@intx/hub-api` composes into the application.

## Why vendored (CL-4231)

Asset kinds were closed upstream: `createAgentRepoStore` built its
kind-handler map from a hardcoded literal, `AssetService.createAsset`
allowlisted three kind strings, and `rowToAsset` switched exhaustively
over the closed `@intx/types/sidecar` `RepoKind` enum and threw on
anything else. Vendoring makes every edit workbench-local — no
submodule change, no interchange pin bump — while keeping the rest of
the package a byte-identical copy.

### WORKBENCH-LOCAL (CL-4231) — the kind seam

- **`src/repo-store/types.ts`** — `RepoKind` is re-declared locally as
  `IntxRepoKind | (string & {})` instead of re-exported from
  `@intx/types/sidecar`. `RepoId` is re-derived against the widened
  kind. The submodule's `RepoKind` stays the closed five-value enum —
  wire-level pack frames still validate against it — this widening is
  a local-typing seam for the hub-side `RepoStore`/`AssetService`
  surface only.
- **`src/agent-repo.ts`** — `createAgentRepoStore` takes an optional
  `handlers: Readonly<Record<string, RegisteredKindHandler>>` (a
  `RegisteredKindHandler` pairs a `KindHandler` with the `authorize`
  function the old code dispatched via a hardcoded switch). Caller
  entries are MERGED with the five built-ins (agent-state, skill,
  package-registry, workflow, workflow-run); a caller kind colliding
  with a built-in name throws at construction. The authorize dispatch
  itself is now a lookup into the merged map instead of the switch.
  `AgentRepoStore.registeredKinds: ReadonlySet<RepoKind>` exposes the
  merged key set so downstream validation (below) has something real
  to check against.
- **`src/asset-service.ts`** — `createAssetService` takes an optional
  `registeredKinds: ReadonlySet<RepoKind>` dep (defaults to
  `DEFAULT_REGISTERED_KINDS`, the five built-ins, so every existing
  caller and test — none of which pass it — is byte-identical in
  behavior). `createAsset`'s hardcoded three-kind allowlist and
  `rowToAsset`'s exhaustive switch are both replaced with membership
  checks against `registeredKinds` (minus `agent-state` and
  `workflow-run`, which stay excluded because they are owned by the
  agent lifecycle and the workflow supervisor respectively, not by
  the asset service). An unregistered kind still fails loudly with
  `AssetServiceError("unsupported_kind", ...)`; a registered kind —
  built-in or caller-added — passes.

A caller opens the seam by constructing `createAgentRepoStore({ ...,
handlers: { "my-kind": { handler, authorize } } })` and passing that
store's `registeredKinds` into `createAssetService`. Guarded by the
"custom kind" describe block in `src/asset-service.test.ts` and
`src/agent-repo.test.ts`, which register a throwaway kind end to end
and assert it gets real git-backed content (a `directoryPrefix` and a
`validatePush` tree check both run, not an identity-only DB row).

**Re-sync rule:** re-copy `src/` from
`interchange/packages/hub-sessions/src` on every pin bump, then
re-apply the three CL-4231 edits above (`repo-store/types.ts`,
`agent-repo.ts`, `asset-service.ts`) — a literal upstream copy
silently re-closes the kind seam with a green build.

**Audit:** `git grep "WORKBENCH-LOCAL (CL-4231)" packages/hub-sessions/`

### Other drift

`src/agent-repo.ts` and its tests import `@workbench/storage-isogit`
in place of `@intx/storage-isogit` — the same substitution
`packages/hub-agent` and `packages/workflow-host` already make, since
the hub reads/writes agent-state and workflow-run repos through the
vendored storage-isogit's `store.ts` (CL-2663 read-serialization
divergence, see its own `docs/VENDORED.md` entry), and every repo
reader/writer on the hub side must stay on the same storage
implementation.

## Imported by

`apps/hub` and `apps/sidecar` (repointed from `@intx/hub-sessions` at
CL-4231), plus `packages/hub-agent`, `packages/tools-dispatch`, and
`packages/workflow-host`, which keep their existing `@intx/hub-sessions`
devDependency for types/tests unless they also need the kind seam.

## Surface

The package barrel (`@workbench/hub-sessions`) re-exports the following,
grouped by concern. A db-free repo substrate — the `RepoStore`, the
workflow-run claim-check and event-log primitives, and the
kind-subscription protocol — is additionally exported from the
`@workbench/hub-sessions/substrate` subpath, which the agent-runtime host
consumes without linking the database layer. See the source modules
for the authoritative type shapes.

### Session orchestration

- `createSessionService` / `SessionService`, `SessionLaunchError` —
  provisions and tears down agent sessions on the connected sidecar.
- `createHubSessionOrchestrator` / `HubSessionOrchestrator`,
  `HubSessionOrchestratorDeps`, `HubSessionRouterFacade` — the
  higher-level orchestrator that wires the router and event
  collectors together.
- `createHubSessionLookups` / `HubSessionLookupsDeps` — builds the
  lookup callbacks the sidecar router needs to resolve sessions.

### Sidecar WebSocket router and events

- `createSidecarRouter` / `SidecarRouter`, `SidecarRouterConfig`,
  `WsHandle` — the hub-side WebSocket router for connected sidecars.
- `createSidecarEmitter` / `SidecarEventEmitter`, `SidecarEventMap`,
  `SidecarEventType`, `SidecarEventListener` — typed event emission
  over the router.
- `SidecarLookups`, `SidecarMailPersistedPayload`,
  `SidecarMailPersistedRow` — router lookup and mail-persistence
  payload shapes.

### Event collection

- `createEventCollectorRegistry` / `EventCollectorRegistry` —
  registry that feeds agent events back to the HTTP layer for
  observability.

### Agent repository store

- `createAgentRepoStore` / `AgentRepoStore`, `DeployContent`,
  `RegisteredKindHandler` — the agent-specific repository store.
- `createRepoStore`, `UserPrincipal`, and the supporting types
  `AuthorizeFn`, `CreateRepoStoreConfig`, `InitRepoOpts`,
  `KindHandler`, `Principal`, `RefEntry`, `RepoAction`, `RepoId`,
  `RepoKind`, `RepoStore` — the generic repo-store substrate the kind
  handlers plug into.

### Repo kind handlers

- Skills: `skillKindHandler`, `skillAuthorize`,
  `skillFrontmatterSchema`, `getSkillIndex`, and the types
  `SkillIndexEntry`, `SkillFrontmatter`, `SkillPrincipal`,
  `SkillHubPrincipal`, `SkillSidecarPrincipal`.
- Package registry: `packageRegistryKindHandler`,
  `packageRegistryAuthorize`, `asTarballEntry`,
  `validateTarballPackageJSON`, and the constants `TARBALLS_PREFIX`,
  `TARBALL_FILENAME_PATTERN`, `REGISTRY_INDEX_PATH`,
  `WORKSPACE_BUILTINS_REGISTRY`.

### Workflow-run substrate

- `workflowRunKindHandler`, `createWorkflowRunReader`, and the
  `WORKFLOW_RUN_*` path constants — the workflow-run repo kind
  handler, its reader, and the on-disk layout constants for the
  workflow-run substrate.

### Asset service

- `createAssetService` / `AssetService`, `AssetServiceError`,
  `DEFAULT_ASSET_REF`, `DEFAULT_REGISTERED_KINDS`, and the supporting
  types `Asset`, `AgentAsset`, `AgentAssetWithAsset`, `AccessMode`,
  `CreateAssetParams`, `PopulateAssetParams`, `AttachAssetParams`,
  `AssetServiceErrorReason`, `ReadAssetBlobParams`,
  `ListAssetBlobsParams`.

### Skills stanza and credential push

- `buildAvailableSkillsStanza` / `AvailableSkillEntry` — renders the
  available-skills stanza injected into agent context.
- `pushSourceUpdates` — pushes credential-source updates to the
  sidecar.
