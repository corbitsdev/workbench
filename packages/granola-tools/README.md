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

The bundle's env requires `granolaApiKey`. When it is absent or empty,
the tool never throws — it returns a completed result with
`isError: true` and content naming the source "not connected", so a
calling agent can degrade gracefully instead of failing its turn.

This package declares one credential handle, `granola`, in its
`package.json`'s `interchange.credentials` field (CL-6028). Connect
Granola once, in Settings · Connections, and every workflow that pins
`@corbits/granola-tools` and binds this handle — `granola-call`,
`process-granola-call`, `pain-point-collateral`, `collateral-generation`,
`morning-brief` — resolves the same tenant-owned credential at launch;
no per-workflow reconnection.

That launch-time resolution (`buildCredentialDelivery`) is proven in
`test/credential-delivery.drizzle.test.ts`. Delivering the resolved
credential into this bundle's `run()` at call time is a separate,
still-open seam — see `src/tool.ts`'s header comment for exactly which
file is missing the wiring — so until that lands, `granolaApiKey` stays
unset in production and the tool correctly reports "not connected."

## Usage

```ts
import { granolaTools } from "@corbits/granola-tools";

const agent = defineAgent({
  // ...
  tools: [granolaTools],
});
```
