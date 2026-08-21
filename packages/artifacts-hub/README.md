# @corbits/artifacts-hub

Tenant-scoped Library HTTP surface over the mounted `@corbits/artifacts`
engine: list (newest-first, paginated, optional text search), get-by-id,
multipart upload, and per-kind-segment counts for the Library nav. Also
exposes a second, narrower surface — the sanctioned workflow-artifacts
path (CL-6000) — so a workflow-process child can persist and read Library
artifacts without a database handle or a browser session.

## Composition

- `createArtifactRoutes` mounts under the tenant-session prefix and uses
  `RequireGrant`/`TenantEnv` from `@intx/hub-api`, reusing the existing
  `asset` resource family so Library grants keep working without a
  parallel vocabulary.
- `createWorkflowArtifactRoutes` mounts outside the tenant-session prefix.
  Every request authenticates via `WorkflowRunAuthenticator`
  (`workflow-auth.ts`) instead of `resolveTenant` + `requireGrant`: the
  sidecar's bearer token (hashed and checked against the `sidecar` table
  via `@intx/crypto` + `@intx/db`) plus the run's own address (resolved
  through `@corbits/folded-runs`' `findFoldedRunByAddress`) together
  scope the call to one run's tenant + principal.
- Both surfaces wrap the same `@corbits/artifacts` engine db handle; the
  store is injected (`ArtifactRoutesStore` / `WorkflowArtifactRoutesStore`)
  so tests exercise happy/empty/cross-tenant paths without a live
  Postgres.
- `@corbits/artifact-tools`' `artifact_list_recent` and
  `@corbits/memory-hub` (workflow-memory's sibling surface) both follow
  the same authenticator pattern this package established.

## Key modules

- `routes.ts` — `createArtifactRoutes`: list/get/upload/counts under
  tenant-session auth; `createArtifactDbStore` wraps the engine db.
- `workflow-auth.ts` — `createWorkflowRunAuthenticator`: resolves a
  sidecar bearer token + run address pair to a tenant/principal/run scope.
- `workflow-routes.ts` — `createWorkflowArtifactRoutes`: `POST /` (create,
  rate-limited to 30/run/minute, 64k-char content cap), `GET /recent`,
  `GET /:id` (read back one artifact's content — the render step of a
  research/due-diligence run reading the Markdown brief it just saved),
  and `POST /binary` (rate-limited alongside `POST /`, base64 body,
  10 MiB decoded cap — same `MAX_UPLOAD_BYTES` ceiling and `ContentStore`
  the tenant Library's own upload path uses, so a run can persist a
  rendered PDF). All four are scoped to the authenticated run's own
  tenant + principal.
- `createUnavailableArtifactRoutes` / `createUnavailableWorkflowArtifactRoutes`
  — honest 503 surfaces when the artifacts plane isn't mounted, so the
  Library UI can distinguish "not configured" from "empty bench".

## Tests

```
cd packages/artifacts-hub && bun test
```

No DATABASE_URL needed — stores are injected fakes.
