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

This package declares one credential handle, `linear`, in its
`package.json`'s `interchange.credentials` field (CL-6028). Connect
Linear once, in Settings · Connections, and every workflow that pins
`@corbits/linear-tools` and binds this handle — `collateral-generation`,
`morning-brief` — resolves the same tenant-owned credential at launch;
no per-workflow reconnection.

That launch-time resolution (`buildCredentialDelivery`) is proven in
`test/credential-delivery.drizzle.test.ts`. Delivering the resolved
credential into this bundle's `run()` at call time is a separate,
still-open seam — see `src/tool.ts`'s header comment for exactly which
file is missing the wiring — so until that lands, `linearApiKey` stays
unset in production and the tool correctly reports "not connected."

## Usage

```ts
import { linearTools } from "@corbits/linear-tools";

const agent = defineAgent({
  // ...
  tools: [linearTools],
});
```
