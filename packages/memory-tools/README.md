# @corbits/memory-tools

The `memory_search`, `memory_add`, and `memory_list` `@intx/agent` tool
bundle (CL-5852): the agent-facing surface a workflow definition pins to
reach the tenant's firm-memory plane (`@corbits/memory`, mounted by
`apps/hub/src/memory-mount.ts`). Also exports the HTTP client
(`searchMemory`, `addMemory`, `listMemory`) the sanctioned
workflow-memory path is built on, calling `@corbits/memory`'s own routes
directly rather than a bespoke parallel surface (CL-6296).

## Tools

- `memory_search` — searches the tenant's firm memory for entries
  relevant to a query.
- `memory_add` — records one entry (title + text, optional kind).
- `memory_list` — lists the tenant's most recent entries as a timeline.

None of the three tools' input schemas accept a tenant or principal
argument. Attribution always comes from the run's own authenticated
identity on the hub side, never from a model-supplied value.

## The sanctioned workflow-memory path (CL-6296)

`@corbits/memory`'s own HTTP routes (`registerMemoryRoutes`, mounted at
`/api/tenants/:tenantId/memory/*`; the `:tenantId` segment is never read)
authenticate via a host-supplied `CallerResolver`. For a browser/API
caller that resolver reads `c.get("principal")`, set by the platform's
tenant-session middleware. A workflow-process child has neither a
database handle nor a browser session, only the sidecar's own bearer
token and the run's own mailbox address (the same pair
`@corbits/artifact-tools` already established this precedent for), so
`apps/hub/src/memory-mount.ts`'s `createAccountCallerResolver` tries that
pair first (via `@corbits/artifacts-hub`'s `WorkflowRunAuthenticator`)
and falls back to the session path only when it's absent — never the
other way around. Either branch resolves to the run's own tenant +
principal, remapped up to the ACCOUNT tenant, before touching the plane.
This package's client calls that SAME mount, never a second surface.

A transport, HTTP, or shape failure comes back as a completed result
with `isError: true` — never fabricate a memory or a search result.

## Rate limit and payload cap (CL-5852, re-homed by CL-6296)

`@corbits/memory`'s own routes enforce no per-run write limit or payload
cap — those are host concerns. `apps/hub/src/memory-mount.ts` re-homes
both as middleware mounted ahead of the `/add` route, active only for a
workflow-run write (never a browser caller): 30 writes/run/minute and a
64k-character cap on `add`'s `text`, sharing
`@corbits/artifacts-hub`'s `workflow-write-limits.ts` with the
workflow-artifacts surface rather than a third hand-rolled copy. A write
over either bound comes back as a `429`/`413`, which `memory_add`
surfaces as `isError: true` like any other HTTP failure.

There is no "memory isn't set up" degraded state to handle: config is
env-only and always resolves to at least a lexical-only floor (CL-6289),
so the memory plane is always mounted. See the root `.env.example`'s
`EMBED_BASE_URL` section for the local-dev option (a local Ollama
instance, no API key needed) alongside the managed-provider one.

## Usage

```ts
import { memoryTools } from "@corbits/memory-tools";

const agent = defineAgent({
  // ...
  tools: [memoryTools],
});
```

The bundle's env requirements (`hubMemoryUrl`, `sidecarToken`,
`address`) are populated automatically for every workflow step — see
`apps/sidecar/src/workflow-substrate-factory/step-env.ts`.

## Tests

```
cd packages/memory-tools && bun test
```

No DATABASE_URL needed — the HTTP client and tool tests run against
injected fakes/mocked fetch.
