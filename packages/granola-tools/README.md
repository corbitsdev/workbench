# @corbits/granola-tools

A minimal Granola integration: two client calls, one `@intx/agent` tool
bundle. Built for the morning-brief workflow (CL-5993); `granola_get_note`
was added by the pain-point-collateral workflow (CL-5995) — neither is
specific to its origin workflow, so both stay in this one package rather
than forking a second Granola client.

## Tools

- `granola_list_recent_notes` — lists the caller's recent call notes
  (`id`, `title`, `summary`, `createdAt`), optionally filtered to notes
  created after a given ISO 8601 timestamp.
- `granola_get_note` — fetches one call note by id, including its
  transcript (`speaker`/`text` lines).

## Credential

The bundle's env carries `credentials`, the harness's consumer-gated
`CredentialCapability` (`vendor/intx/harness/src/credential-capability.ts`).
When it is absent, or `credentials.resolve("granola")` throws — no bound
handle, or a grant that doesn't authorize this consumer — the tool never
throws itself: it returns a completed result with `isError: true` and
content naming the source "not connected", so a calling agent can
degrade gracefully instead of failing its turn.

This package declares one credential handle, `granola`, in its
`package.json`'s `interchange.credentials` field (CL-6028). Connect
Granola once, in Settings · Connections, and every workflow that pins
`@corbits/granola-tools` and binds this handle — `granola-call`,
`process-granola-call`, `pain-point-collateral`, `collateral-generation`,
`morning-brief` — resolves the same tenant-owned credential at launch;
no per-workflow reconnection.

Launch-time resolution (`buildCredentialDelivery`) is proven in
`test/credential-delivery.drizzle.test.ts`; the full chain — seeded
credential through the sidecar's step wiring
(`apps/sidecar/src/step-agent-tools.ts`) to this bundle's tool call — is
proven in `test/credential-wiring-e2e.drizzle.test.ts` (CL-6032). See
`docs/credential-wiring.md` for the end-to-end picture and the provider
plugins involved (this package's Granola credential uses the vendored
`http` / Bearer plugin; `@corbits/linear-tools`'s Linear credential does
not).

## Usage

```ts
import { granolaTools } from "@corbits/granola-tools";

const agent = defineAgent({
  // ...
  tools: [granolaTools],
});
```

## Running tests

```
cd packages/granola-tools && bun test
```

`test/credential-delivery.drizzle.test.ts` and
`test/credential-wiring-e2e.drizzle.test.ts` need a live Postgres:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
