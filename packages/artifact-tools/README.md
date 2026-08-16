# @corbits/artifact-tools

The `artifact_list_recent` `@intx/agent` tool bundle: the agent-facing
surface `collateral-generation` (CL-5996) needs to offer workbench Library
artifacts as source material, alongside `@corbits/granola-tools` and
`@corbits/linear-tools`. Also exports the HTTP client
(`createWorkflowArtifact`, `listRecentWorkflowArtifacts`) the sanctioned
workflow-artifacts path (CL-6000) is built on, so workflow finalize tools
persist through the same client this bundle reads through.

## Tool

- `artifact_list_recent` — lists the tenant's recent Library artifacts
  (id, title, kind, created-at) for use as source material.

## The sanctioned workflow-artifacts path (CL-6000)

Tool packages run inside the sidecar's workflow-process child, a separate
process with no database handle and no browser session. Rather than
handing the child either of those, the child authenticates to a dedicated
hub HTTP surface (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`,
mounted at `/api/workflow-artifacts`) with two things it already carries:
the sidecar's own bearer token (the same one used for workflow-run
pack-push) and the run's own mailbox address. The hub resolves that pair to
the run's tenant and principal and scopes every read/write to it — a run
can never see or write another tenant's artifacts, and the child never
holds a database credential.

`artifact_list_recent` calls `listRecentWorkflowArtifacts` against that
surface and returns a completed result with `isError: true` (never
fabricated artifacts) on any transport, HTTP, or shape failure — same
convention as `@corbits/linear-tools`/`@corbits/granola-tools`.

## Usage

```ts
import { artifactTools } from "@corbits/artifact-tools";

const agent = defineAgent({
  // ...
  tools: [artifactTools],
});
```

The bundle's env requirements (`hubArtifactsUrl`, `sidecarToken`,
`address`) are populated automatically for every workflow step — see
`apps/sidecar/src/workflow-substrate-factory/step-env.ts`.

## Tests

```
cd packages/artifact-tools && bun test
```

No DATABASE_URL needed — the HTTP client and tool tests run against
injected fakes/mocked fetch.
