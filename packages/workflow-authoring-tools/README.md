# @corbits/workflow-authoring-tools

The `@intx/agent` tool bundle over `@corbits/workflows`'s `./authoring`'s
workflow-run-authenticated routes (CL-7360): an agent writes an ordinary
workflow code package into a `kind: "workflow"` hub asset, republishes it,
and reads it back. See [docs/workflow-source-authoring.md](../../docs/workflow-source-authoring.md)
for the contract this implements.

## The tools

None of the three is `approval: "ask"`: storing source is not a side effect.
Deploying an asset so it can run is a separate, human-approved step
(`workflow_deploy`, CL-7362), never this bundle's job.

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

Every request carries the run's own sidecar bearer token and
`x-workflow-run-address`; the hub resolves tenant and principal from the run
and authorizes `asset:*`/`create`, `asset:<id>`/`write`, or
`asset:<id>`/`read` against the grant store before anything reaches git. The
hub also validates the tree at the boundary (repo-relative paths, no
secret-like filenames, `package.json` declaring an `interchange.workflow`
entry the tree carries, size caps) and returns a message the model can act
on.

## Routes and client

| Tool                   | Route                                                  | Client function      |
| ---------------------- | ------------------------------------------------------ | -------------------- |
| `workflow_author`      | `POST /api/workflow-workflow-authoring/author`         | `authorWorkflow`     |
| `workflow_republish`   | `POST /api/workflow-workflow-authoring/republish`      | `republishWorkflow`  |
| `workflow_source_read` | `GET /api/workflow-workflow-authoring/:assetId/source` | `readWorkflowSource` |

A hub refusal surfaces as `WorkflowAuthoringRequestError` (`status`, `code`,
`currentHeadSha` on a conflict); the bundle lets it throw, and
`@intx/agent`'s tool runner turns the message into an `isError` result.

## Env

`requires: ["hubWorkflowAuthoringUrl", "sidecarToken", "address"]` —
`hubWorkflowAuthoringUrl` is threaded in
`apps/sidecar/src/workflow-substrate-factory/step-env.ts` exactly like
`hubCapabilitiesUrl`.

## Bundle id

`@corbits/workflow_authoring/wf`, not `@corbits/workflow-authoring-tools/…`:
the qualified `<id>:<tool>` must fit OpenAI's 64-character wire cap after
`encodeToolName` escapes `@`, `/`, `:` and `-` to three characters each.

## Running tests

```sh
cd packages/workflow-authoring-tools && bun test
```

Tests run against a mocked fetch; no `DATABASE_URL` or live hub is required.
