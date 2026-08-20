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
`CredentialCapability` (`@intx/harness/src/credential-capability.ts`).
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
`test/credential-delivery.drizzle.test.ts`; the full chain — seeded
credential through the sidecar's step wiring
(`apps/sidecar/src/step-agent-tools.ts`) to this bundle's tool call — is
proven in `test/credential-wiring-e2e.drizzle.test.ts` (CL-6032).

**Provider plugin.** Linear's API expects the raw key verbatim in
`authorization`, not a `Bearer `-prefixed token. `@intx/harness`'s
vendored `http` provider always sends Bearer, so a Linear provider row
MUST set `plugin: "http-raw-authorization"`
(`@corbits/credential-providers`) rather than the `"http"` default other
connectors use — seeding it wrong sends the wrong header shape and
Linear rejects the call. See `docs/credential-wiring.md` and
`test/linear-raw-authorization-regression.test.ts`, a regression guard
for exactly this bug.

## Usage

```ts
import { linearTools } from "@corbits/linear-tools";

const agent = defineAgent({
  // ...
  tools: [linearTools],
});
```

## Running tests

```
cd packages/linear-tools && bun test
```

`test/credential-delivery.drizzle.test.ts` and
`test/credential-wiring-e2e.drizzle.test.ts` need a live Postgres:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
