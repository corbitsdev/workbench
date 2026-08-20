# @corbits/memory-tools

The `memory_search`, `memory_add`, and `memory_list` `@intx/agent` tool
bundle (CL-5852): the agent-facing surface a workflow definition pins to
reach the tenant's firm-memory plane (`@corbits/memory`, mounted by
`apps/hub/src/memory-mount.ts`). Also exports the HTTP client
(`searchMemory`, `addMemory`, `listMemory`) the sanctioned
workflow-memory path is built on.

## Tools

- `memory_search` — searches the tenant's firm memory for entries
  relevant to a query.
- `memory_add` — records one entry (title + text, optional kind).
- `memory_list` — lists the tenant's most recent entries as a timeline.

None of the three tools' input schemas accept a tenant or principal
argument. Attribution always comes from the run's own authenticated
identity on the hub side, never from a model-supplied value.

## The sanctioned workflow-memory path (CL-5852)

`@corbits/memory`'s own HTTP routes (`registerMemoryRoutes`, mounted at
`/api/tenants/:tenantId/memory/*`) authenticate via
`c.get("principal")`, set by the platform's tenant-session middleware —
a caller with a browser/API session. A workflow-process child has
neither a database handle nor a browser session, only the sidecar's own
bearer token and the run's own mailbox address (the same pair
`@corbits/artifact-tools` already established this precedent for). This
package's tools instead call `@corbits/memory-hub`'s
`createWorkflowMemoryRoutes` (mounted at `/api/workflow-memory`, outside
the tenant-session prefix), which authenticates that pair via
`@corbits/artifacts-hub`'s `WorkflowRunAuthenticator` and resolves it to
the run's own tenant + principal before touching the plane.

A transport, HTTP, or shape failure comes back as a completed result
with `isError: true` — never fabricate a memory or a search result.

## When the memory plane isn't configured (CL-6168)

`apps/hub/src/memory-mount.ts` decides whether the memory plane is
mounted at hub boot, from its own `EMBED_BASE_URL` config parse — never
by making a call and seeing what happens. An unmounted plane is reflected
two ways, both driven by that one boot-time decision:

- The hub's tool inventory (`listMyraUsableToolPackages` in
  `apps/hub/src/index.ts`) simply never offers `@corbits/memory-tools` to
  an agent, the same way `@corbits/mcp-tools` is only offered when an MCP
  server connection exists — so an unconfigured hub never tempts Myra
  into believing memory works.
- If a tool call reaches `/api/workflow-memory` anyway,
  `createUnavailableWorkflowMemoryRoutes` answers a `503` with
  `error.code: "unavailable"`, which `memory_search`/`memory_add`/
  `memory_list` each translate into a plain-language, `isError: false`
  result ("Memory isn't set up on this server yet — proceeding without
  it.") instead of surfacing HTTP noise. Any OTHER failure (a real
  network error, an unexpected shape, an actual 5xx) still comes back as
  `isError: true` — the distinction is the hub's own honest signal, not a
  transport error being swallowed.

See the root `.env.example`'s `EMBED_BASE_URL` section for the local-dev
option (a local Ollama instance, no API key needed) alongside the
managed-provider one.

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
