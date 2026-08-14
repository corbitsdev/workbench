# @corbits/linear-tools

A minimal Linear integration: one client call, one `@intx/agent` tool
bundle. Built for the morning-brief workflow (CL-5993) but not specific
to it — any agent that needs a user's recently updated Linear issues
pins this package.

## Tool

`linear_list_recent_issues` — lists issues assigned to the caller
(`id`, `identifier`, `title`, `state`, `url`, `updatedAt`),
most-recently-updated first, optionally filtered to issues updated
after a given ISO 8601 timestamp.

## Credential

The bundle's env requires `linearApiKey`. When it is absent or empty,
the tool never throws — it returns a completed result with
`isError: true` and content naming the source "not connected", so a
calling agent can degrade gracefully instead of failing its turn.

## Usage

```ts
import { linearTools } from "@corbits/linear-tools";

const agent = defineAgent({
  // ...
  tools: [linearTools],
});
```
