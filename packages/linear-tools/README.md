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

The bundle's env carries `credentials`, the harness's consumer-gated
`CredentialCapability` (`vendor/intx/harness/src/credential-capability.ts`).
When it is absent, or `credentials.resolve("linear")` throws — no bound
handle, or a grant that doesn't authorize this consumer — the tool never
throws itself: it returns a completed result with `isError: true` and
content naming the source "not connected", so a calling agent can
degrade gracefully instead of failing its turn.

This package declares one credential handle, `linear`, in its
`package.json`'s `interchange.credentials` field (CL-6028). Connect
Linear once, in Settings · Connections, and every workflow that pins
`@corbits/linear-tools` and binds this handle — `collateral-generation`,
`morning-brief` — resolves the same tenant-owned credential at launch;
no per-workflow reconnection.

Launch-time resolution (`buildCredentialDelivery`) is proven in
`test/credential-delivery.drizzle.test.ts`. This package has no
DB-gated wiring end-to-end test of its own (see
`@corbits/granola-tools`'s `test/credential-wiring-e2e.drizzle.test.ts`,
CL-6032, for the pattern) — the substrate-side composition it depends on
is shared and covered there plus in `apps/sidecar/src/step-agent-tools.test.ts`.

## Usage

```ts
import { linearTools } from "@corbits/linear-tools";

const agent = defineAgent({
  // ...
  tools: [linearTools],
});
```
