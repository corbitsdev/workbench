# @corbits/agent-directory

Creates agent definitions as workflow assets the tenant can browse, invite,
and launch: the single-step folded workflow a hand-authored agent
materializes as (`agent-workflow.ts`), request validation (`validation.ts`),
and the hub routes that create a definition and manage its attached skills
(`routes.ts`) — server-side, backed by `@intx/agent`, `@intx/workflow`,
`@intx/hub-sessions`, and Postgres via `@intx/db`.

## `/client` subpath contract

`@corbits/agent-directory/client` (`src/client.ts`) is the browser-safe
counterpart: the "what counts as a user-facing agent" rule a directory UI
applies once definitions and instances are already in hand. Kept apart from
the root export so a browser bundle never pulls in `@intx/agent`,
`@intx/workflow`, `@intx/hub-sessions`, `drizzle-orm`, or `hono` — this
subpath imports none of them.

This extends the package's existing charter (agent definitions, broadly)
rather than living in a new sibling package: both halves answer "what is an
agent definition/instance, and which ones does a person actually see,"
just at different points in the request lifecycle.

**Owns:**

- `purposeAgentDefinitions` / `purposeAgentInstances` — drops the chat
  anchor machinery's channel-host rows; those are internal plumbing, never
  an agent a person created. `purposeAgentInstances` also takes an
  `excludeRunIds` set for folded chat runs (invited agents) that
  self-anchor like real deployments under a real `definitionId`, which the
  name-based filter alone can't catch.
- `filterDefinitions` / `filterInstances` — full-text search across the
  fields a person actually reads (name, description), never a raw id.
- `isOrphanedInstance` / `definitionsById` — flags an instance whose
  `definitionId` the tenant's own definitions listing no longer carries
  (deleted, or scrolled past a page's fetch window), so a UI marks it
  instead of silently hiding it.

**A host injects:** its own definition and instance lists, already fetched
from wherever it gets them (`apps/web/src/agents-api.ts`'s
`loadAgentDirectory`, for this repo), and the folded-run-id set for
`excludeRunIds` (from `@corbits/chat-ui`'s
`foldedRunIdsFromChannels`, for this repo) — this subpath issues no
request and holds no state of its own. Every function is generic over the host's
concrete row type (constrained to the minimal shape it reads), so a host's
richer types pass through untouched.

**Depends on:** `@corbits/chat/channel-host-naming` directly — a domain
package's naming contract, not app state, so it is a package dependency
rather than something a host injects.

**Never imports:** no `apps/web`-specific state, no UI framework — this
subpath is plain TypeScript, safe in any browser bundle or server context.
