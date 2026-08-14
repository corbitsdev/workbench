# @corbits/artifact-tools

The `artifact_list_recent` `@intx/agent` tool bundle: the agent-facing
surface `collateral-generation` (CL-5996) needs to offer workbench Library
artifacts as source material, alongside `@corbits/granola-tools` and
`@corbits/linear-tools`.

## Tool

- `artifact_list_recent` — lists the tenant's recent Library artifacts
  (title, kind, created-at) for use as source material.

## Current limit (read before wiring this in)

Unlike Granola or Linear, there is no per-user credential this bundle is
missing — the gap is structural. Tool packages run inside the sidecar's
workflow-process child, a separate process with no database handle and no
authenticated path to the hub's Library engine. `@corbits/pain-point-collateral-workflow`
surfaced the write side of this gap (CL-6000, "Workflow tools can't persist
Library artifacts"); listing hits the identical gap on the read side. So
`artifact_list_recent` always returns a completed result with
`isError: true`, naming the source "not reachable yet" and citing CL-6000,
rather than fabricating artifacts or inventing a one-off auth path around
the platform gap. The moment CL-6000 lands a sanctioned workflow-tool-to-hub
path, wiring the real `artifact_list` call in is a one-line change to
`src/tool.ts`, not a redesign.

## Usage

```ts
import { artifactTools } from "@corbits/artifact-tools";

const agent = defineAgent({
  // ...
  tools: [artifactTools],
});
```
