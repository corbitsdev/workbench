# @corbits/workflow-authoring-tools

The `@intx/agent` tool bundle over `@corbits/workflows`'s `./authoring`'s
workflow-run-authenticated routes (CL-7360): an agent writes an ordinary
workflow code package into a `kind: "workflow"` hub asset, republishes it,
and reads it back. See [docs/workflow-source-authoring.md](../../docs/workflow-source-authoring.md)
for the contract this implements.

## The tools

Only `workflow_deploy` is `approval: "ask"`: storing source is not a side
effect, but making a workflow runnable is.

- `workflow_author({ name, files, message? })` — creates the asset and
  commits the tree; returns `{ assetId, name, commitSha }`. `name` is
  lowercase-kebab and unique per tenant (a duplicate is a 409).
- `workflow_republish({ assetId, files, message?, expectedHeadSha? })` —
  commits a new version of the whole package. With `expectedHeadSha`, a
  moved `refs/heads/main` is refused with 409 and the current head; the
  agent re-reads and retries. Writes are additive: a path omitted keeps its
  committed content.
- `workflow_source_read({ assetId })` — every file on `refs/heads/main` plus
  `headSha`, as JSON.
- `wf_deploy_preview({ assetId, commitSha, entry })` — a static read of the
  already-committed source: package name, file list, and any statically
  declared `toolPackagePins`. Never installs, probes, gates, or freezes.
- `workflow_deploy({ assetId, commitSha, entry, packageName?, toolPackagePins? })`
  — deploys the committed source through Interchange's native pipeline behind
  a human approval. `packageName`/`toolPackagePins` come from a prior
  `wf_deploy_preview` on the same commit and are shown on the approval card;
  they are not sent to the hub.

Every request carries the run's own sidecar bearer token and
`x-workflow-run-address`; the hub resolves tenant and principal from the run
and authorizes `asset:*`/`create`, `asset:<id>`/`write`, or
`asset:<id>`/`read` against the grant store before anything reaches git. The
hub also validates the tree at the boundary (repo-relative paths, no
secret-like filenames, `package.json` declaring an `interchange.workflow`
entry the tree carries, size caps) and returns a message the model can act
on.

## Routes and client

| Tool                   | Route                                                           | Client function         |
| ---------------------- | --------------------------------------------------------------- | ----------------------- |
| `workflow_author`      | `POST /api/workflow-workflow-authoring/author`                  | `authorWorkflow`        |
| `workflow_republish`   | `POST /api/workflow-workflow-authoring/republish`               | `republishWorkflow`     |
| `workflow_source_read` | `GET /api/workflow-workflow-authoring/:assetId/source`          | `readWorkflowSource`    |
| `wf_deploy_preview`    | `POST /api/workflow-workflow-authoring/:assetId/deploy/preview` | `previewDeployWorkflow` |
| `workflow_deploy`      | `POST /api/tenants/:tenantId/workflows/deployments` (stock)     | `deployWorkflow`        |

`workflow_deploy` speaks stock Interchange routes (CL-8171): it reads the
tenant's resolved inference catalog from `GET /api/tenants/:tenantId/models`,
flattens it into one priority-ordered `sourceOfferingIds` chain, and posts an
`asset`/`source` deploy naming the commit. The run bearer authenticates both.

The four authoring operations still call the Workbench-specific
`/api/workflow-workflow-authoring` mount. Their stock equivalent is git
smart-HTTP on the asset repo, which no run-bearer credential reaches today:
`createGitTokenAuth` accepts only an `itx_pat_`/`itx_svc_` git token, and the
stock mint route (`POST /api/tenants/:tenantId/git-tokens`) refuses a caller
with no browser session. CL-8171 carries that upstream ask.

A hub refusal surfaces as `WorkflowAuthoringRequestError` (`status`, `code`,
`currentHeadSha` on a conflict); the bundle lets it throw, and
`@intx/agent`'s tool runner turns the message into an `isError` result.

## Env

`requires: ["hubWorkflowAuthoringUrl", "tenantId", "sidecarToken", "address"]`
— all four are threaded in
`apps/sidecar/src/workflow-substrate-factory/step-env.ts`;
`hubWorkflowAuthoringUrl` exactly like `hubCapabilitiesUrl`, `tenantId` from
the hub's signed deploy frame, as the `:tenantId` segment of the stock routes
`workflow_deploy` calls.

## Bundle id

`@corbits/workflow_authoring/wf`, not `@corbits/workflow-authoring-tools/…`:
the qualified `<id>:<tool>` must fit OpenAI's 64-character wire cap after
`encodeToolName` escapes `@`, `/`, `:` and `-` to three characters each.

## Running tests

```sh
cd packages/workflow-authoring-tools && bun test
```

Tests run against a mocked fetch; no `DATABASE_URL` or live hub is required.
