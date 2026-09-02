# Workflow definition detail (CL-7371)

A workflow definition's own page: `GET
/api/tenants/:tenantId/workflows/definitions/:definitionAssetId/detail`
(`packages/workflow-catalog/src/detail-route.ts`), read at `/workflows/
:definitionAssetId` (`apps/web/src/pages/workflow-detail-page.tsx`). First
useful version — read-only, no editing surface here.

## What it answers

- **Lifecycle**: `source-only`, `pending-approval`, `deployed`,
  `superseded`, or `build-failed` — derived by the pure
  `deriveWorkflowLifecycle` (`packages/workflow-catalog/src/
definition-lifecycle.ts`) from the asset's newest `workflow_definition`
  row plus whether `@corbits/workflow-deploy-source` ever recorded a
  deploy attempt for it. No new Postgres column: everything it reads is
  native or already Workbench-owned.
- **Steps**: read from the frozen `wire_projection` (`@intx/db`'s
  `loadFrozenWireProjection`) in `stepOrder`, each carrying its role
  (`kind`), best-effort director/model/tool pins (the wire step schema is
  deliberately open past `kind`/`id`/`after` — see
  `vendor/intx/types/src/wire-workflow.ts` — so these read defensively and
  are simply absent rather than erroring on an unrecognized shape), and the
  grants the deploy-time capability walk froze onto that step
  (`grantSnapshot.perStep`).
- **Access**: declared grants (the source's own `grant_requirements`) next
  to approved grants (the last freeze's `grant_snapshot.grantRequirements`)
  — a person can see the gap between what a workflow asks for and what was
  actually approved. Credential binding **names** only
  (`workflow_definition.credential_bindings[].handle`); no value is ever
  read or returned.
- **Source**: the deploying commit sha, entry module, and origin kind, from
  `@corbits/workflow-deploy-source`'s per-asset deploy record — `null` when
  no deploy was ever attempted.

## Authorization

`requireGrant(idResource("workflow-definition", "definitionAssetId"),
"read")` runs before any row is read. An asset absent or owned by another
tenant reads as 404 from the route body itself (same convention as the
vendored `.../:definitionId/versions` route), never a 403 that would
confirm the id exists.

## What's deliberately left out of this first version

- No cross-links from the routine target picker or an agents roster row —
  neither exists yet on the branch this shipped against. Wiring those in
  is a follow-up once they land.
- `superseded` is read off `workflow_definition.status: "stopped"` on the
  newest row for the asset, not a full multi-row version history; a
  definition's older wire hashes are not separately browsable from this
  page yet.
