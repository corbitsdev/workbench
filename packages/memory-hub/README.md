# @corbits/memory-hub

The sanctioned path for a workflow-process child to reach the mounted
`@corbits/memory` plane (CL-5852): `createWorkflowMemoryRoutes`, mounted
at `/api/workflow-memory` outside the tenant-session prefix, mirroring
`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`.

## Why not `@corbits/memory`'s own HTTP routes

`@corbits/memory` is a vendored pin (never edited in this repo). Its own
`registerMemoryRoutes` authenticates via `c.get("principal")`, set by
the platform's tenant-session middleware for a browser/API caller. A
workflow-process child has no browser session — only the sidecar's own
bearer token and the run's own mailbox address. Reusing the plane's
tenant-session routes for that caller isn't possible without a session
to present, so this package establishes the same seam
`@corbits/artifact-tools`/`@corbits/artifacts-hub` already did for
Library artifacts (CL-6000): a narrower surface, authenticated by
`@corbits/artifacts-hub`'s `WorkflowRunAuthenticator` (itself generic —
no artifact coupling), serving through the plane's SAME in-process
`Memory` handle `apps/hub/src/memory-mount.ts`'s `mountMemory` returns,
never a second connection.

## Routes

- `POST /search` — `{query, limit?, kinds?}` → the tenant's search
  results.
- `POST /add` — `{title, text, kind?}` → the created entry's
  `documentId`/`versionId`.
- `GET /list?limit=` — the tenant's recent timeline.

Every route scopes to the authenticated run's own tenant + principal.
Identity never rides in the request body: a caller-supplied `tenantId`
or `principalId` in a body is parsed and then explicitly discarded, not
forwarded to the plane.

`createUnavailableWorkflowMemoryRoutes` answers `503` on every route
when the memory plane isn't mounted (no `EMBED_BASE_URL`).
