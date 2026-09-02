# Authoring workflow source as a hub asset

Contract for CL-7352: how an agent (Myra) or a person writes a workflow code
package into the hub and gets it deployed through Interchange's native
pipeline. Companion to [workflow-model.md](workflow-model.md).

## The package shape

A `kind: "workflow"` asset carries an ordinary code package. The push
validator (`vendor/intx/hub-sessions/src/workflow-kind.ts`,
`workflowKindHandler.validatePush`) accepts nothing else.

```
package.json      — name, version, "type": "module", "interchange": { "workflow": "./workflow.ts" }
workflow.ts       — default-exports defineWorkflow({ ... }) from @intx/workflow
<other files>     — anything the entry imports; no secrets, no .env
```

Rules the authoring boundary enforces before any write:

- Paths are repo-relative, normalized, no `..`, no leading `/`, no
  `.git/`. Names matching secret-like patterns (`.env*`, `*.pem`, `*.key`,
  `id_rsa*`) are rejected.
- `package.json` parses, declares a non-empty `interchange.workflow`, and
  that entry exists in the same tree.
- Total tree size and per-file size are capped.
- The asset name is lowercase-kebab (`ASSET_NAME_PATTERN`).

Inert JSON definitions (`export default {...}` written by
`renderWorkflowSourceTree`) remain a valid package shape for hub-generated
single-step agents, because they are code the sidecar evaluates. They are
not what an agent authors by hand.

## The operations, in order

| Step | Operation                                                                                                                                                                                                                                                        | Authorized as                                                                                                                                                    | Returns                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1    | `POST /api/workflow-workflow-authoring/author` (`@corbits/agent-workflow-authoring`) → `AssetService.createAsset` + `populateAsset`                                                                                                                              | Run bearer + run address → tenant/principal; `asset:*`/`create`                                                                                                  | `{ assetId, name, commitSha }`                       |
| 1'   | `.../republish` → `populateAsset` on `refs/heads/main`                                                                                                                                                                                                           | `asset:<assetId>`/`write`, own-tenant row check first                                                                                                            | `{ assetId, name, commitSha }`                       |
| 1''  | `GET .../:assetId/source` → `RepoStore.resolveRef` + `openCommittedReads` on `refs/heads/main`                                                                                                                                                                   | `asset:<assetId>`/`read`, own-tenant row check first                                                                                                             | `{ assetId, name, headSha, files }`                  |
| 2    | Preview: native probe with empty `ApprovalSet`, no freeze (CL-7362, not yet built)                                                                                                                                                                               | Same run scope                                                                                                                                                   | `{ wireHash, grants[] }` or an invalid-package error |
| 3    | `POST /api/workflow-workflow-authoring/:assetId/deploy` (CL-7361) → same `sessionService.deployWorkflowFromSource` call the native `POST /api/tenants/:tenantId/workflows/deployments` route drives, with `sources` resolved server-side from the tenant catalog | Run bearer + run address → tenant/principal; `workflow:*`/`create`, own-tenant row check first; the `workflow_deploy` tool call itself carries `approval: "ask"` | `{ deploymentId, definitionAssetId, status }`        |
| 4    | Human resolves the parked approval (native `approvals` route)                                                                                                                                                                                                    | `approval:*`/`resolve`                                                                                                                                           | Deploy continues or is rejected                      |
| 5    | `workflow_definition` row frozen; appears in routine target discovery                                                                                                                                                                                            | —                                                                                                                                                                | Launchable                                           |

The deploy body is the same one `packages/hub-client/src/seed.ts` sends:

```json
{
  "source": {
    "kind": "asset",
    "assetId": "<assetId>",
    "package": { "format": "source", "commitSha": "<sha>" }
  },
  "entry": "./workflow.ts",
  "sources": [
    {
      "id": "...",
      "provider": "...",
      "baseURL": "...",
      "apiKey": "...",
      "model": "..."
    }
  ],
  "defaultSource": "..."
}
```

`sources` is resolved server-side from the tenant's inference catalog for
agent-initiated deploys; an agent never supplies or sees provider secrets.
`commitSha` is the pin: the same asset at a different commit is a different
deploy. `@corbits/workflow-deploy-source` records `{ assetId, commitSha,
entry }` per placement so redeploy re-resolves sources fresh from the
recorded initiating principal.

## Identity, conflicts, idempotency

- Asset identity is the asset id; the human-readable name is unique per
  tenant (`duplicate_asset` → 409 conflict).
- A republish carries `expectedHeadSha`. If the ref moved, the write is
  rejected with 409 and the current head (`currentHeadSha` beside the error
  envelope); the caller re-reads and retries. Nothing is silently
  overwritten. The check is a read-then-write against `RepoStore.resolveRef`
  rather than a compare-and-set inside `writeTree` — `receivePack` has CAS,
  `writeTree` does not — so two republishes racing inside that window are
  serialized by the repo lock, not refused.
- `populateAsset` is additive. A republish overwrites the paths it names and
  carries every other committed file forward; `workflow_source_read` shows
  the whole resulting tree. Deleting a file needs a seam that does not exist
  yet.
- Writing an identical tree is a no-op commit (content-aware, like the CLI
  pusher). Retrying an `author` after a network failure hits
  `duplicate_asset`; the caller then republishes.
- An authored-but-never-deployed asset is a draft by state, not by table:
  it has no `workflow_definition` row. It stays in the asset store until
  deleted; it never appears in routine target discovery.
- Every operation is authorized as the run's own tenant and principal
  (`WorkflowRunAuthenticator`); no tool argument names a tenant or asset it
  cannot already reach.

## Sequence

```mermaid
sequenceDiagram
  participant H as Human
  participant M as Myra (run)
  participant A as agent-workflow-authoring
  participant S as AssetService (git)
  participant D as /workflows/deployments
  participant P as Sidecar probe
  participant R as Routine targets

  H->>M: "make a routine that does X"
  M->>A: author { name, files }
  A->>A: authorize asset:*/create, validate paths + package
  A->>S: createAsset + populateAsset (hub-signed commit)
  S-->>M: { assetId, commitSha }
  M->>A: deploy preview { assetId, commitSha }
  A->>P: probe (empty ApprovalSet, no freeze)
  P-->>M: { wireHash, grants }
  M->>M: workflow_deploy (approval: ask) parks
  H->>H: inspects asset, commit, grants; approves
  M->>D: POST { source: asset/source/commitSha, entry }
  D->>P: bundle, probe, capability walk
  P-->>D: wireHash must equal approved; else fail closed
  D->>D: freeze workflow_definition (approved_wire_hash, grant_snapshot)
  D-->>M: deployment { definitionAssetId }
  R-->>H: definition selectable as routine target
```

## Seams that exist

- `@corbits/workflow-authoring-tools` (CL-7360, `workflow_deploy` CL-7361):
  `workflow_author`, `workflow_republish`, `workflow_source_read`, and
  `workflow_deploy` (the only one carrying `approval: "ask"`) over the
  routes above, pinned into Myra's `ASSISTANT_TOOL_PACKAGE_PINS` and
  published to the `corbits-tools` registry.
- `POST /api/workflow-workflow-authoring/:assetId/deploy`
  (`agent-workflow-authoring`, CL-7361): a run-authenticated mirror of the
  native `/workflows/deployments` route, injected from `apps/hub/src/
index.ts` as a `WorkflowDeployer` wrapping the same
  `sessionService.deployWorkflowFromSource` call (through
  `withDeploySourceRecording`) with sources resolved server-side.
- Path/package validation in `agent-workflow-authoring`'s registry
  (`validateWorkflowSourceTree`, CL-7360): runs before any grant check or
  write; caps are `MAX_SOURCE_FILE_BYTES`, `MAX_SOURCE_TREE_BYTES`,
  `MAX_SOURCE_FILE_COUNT`.

## Seams that do not exist yet (and where they go)

- A preview operation returning the probed capability surface before
  `workflow_deploy` parks (step 2 in "Deploy approval for agent-authored
  workflows", `workflow-model.md`): CL-7362. Until then, the parked
  approval's snapshot is `workflow_deploy`'s own tool-call arguments
  (asset id, commit, entry) — a human sees what will be deployed, not yet
  the grants it will hold.
- Deleting a file from an authored asset (a `writeTreeDelta`-backed
  republish, or a `clearPrefix` the substrate accepts at the root).
- A compare-and-set republish (`expectedHeadSha` enforced under the repo
  lock rather than before it).

Nothing here adds a repository, compiler, probe, freezer, or approval store.
