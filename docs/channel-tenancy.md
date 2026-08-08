# Channel tenancy

Every channel `@corbits/chat` creates is minted as a native child tenant of
the bench it was created in, on Interchange's own parent/child tenant
hierarchy (`tenant.parentId`). This document describes the model, the seams
`@corbits/chat` owns because no native route covers them, and the gaps
still open upstream.

## What creation does

`POST /api/tenants/:tenantId/chat/channels` (`packages/chat/src/routes.ts`):

1. Mints a new tenant via `ChannelTenancyStore.createChannelTenant`
   (`packages/chat/src/channel-tenancy.ts`), parented under the calling
   bench (`tenant.parentId = <bench id>`). The child tenant is seeded
   exactly as the native `POST /api/tenants` route seeds one it creates
   directly — the same `owner`/`admin`/`member` system roles, the same
   grant shapes — so it is indistinguishable from a tenant created by
   hand through that route.
2. Seeds the child tenant's `owner` principal for the creator's own auth
   user id (`principal.refId`), so the creator is a first-class native
   member of the channel's own tenant, not just of the parent bench.
3. Records the parent↔child link in `channel_tenancy`
   (`packages/chat/src/schema.ts`), the table this package owns for
   exactly this purpose.
4. Launches the channel host and stores `channel_settings` /
   `channel_launch` unchanged from before this feature: both remain
   scoped to the parent bench's tenant id, not the new child tenant.

Point 4 is a deliberate, documented limitation — see "What still lives in
the parent bench" below.

## The listing seam

No native hub-api route lists a tenant's children (`tenant.parentId` is
stored but never queried by any route in `vendor/intx/hub-api`). Rather
than leave "which channels are child tenancies of this bench" unanswerable,
`@corbits/chat` owns the answer from its own `channel_tenancy` table via
`ChannelTenancyStore.listChildChannelTenancies`.

`GET .../chat/channels` annotates every row from `channel_settings` (still
queried by the same `tenantId` scope as before) with its `channel_tenancy`
link, when one exists:

- `tenancy: { tenantId, parentTenantId, slug }`, `legacy: false` — a
  channel created after this rollout, with a real child tenant behind it.
- `tenancy: null`, `legacy: true` — a **legacy** channel: one created
  before channel tenancy existed, with no tenant of its own. This branch
  and the `legacy` field are filed for removal once every channel in a
  production database has been backfilled a tenancy; until then, dropping
  it silently would be exactly the kind of fallback AGENTS.md forbids, so
  it stays explicit in the route and in this document instead.

## Movability

`POST .../chat/channels/:id/move` re-parents a channel's tenancy to a new
bench. There is no native `PATCH` for a tenant's `parentId`, so the move
updates two places, both owned by this package's own service code:

1. The `channel_tenancy` link row (`parentTenantId`) — the source
   `listChildChannelTenancies` reads.
2. The native `tenant.parentId` column itself, directly, through
   `@intx/db`'s published schema (`import { tenant } from "@intx/db/schema"`)
   — this is ordinary consumption of a published table export, not a fork
   of `vendor/intx/hub-api`'s tenant routes.

A channel with no `channel_tenancy` link (a legacy channel) cannot be
moved; the route returns `409 conflict` rather than silently no-op'ing.

## What still lives in the parent bench

The channel host's workflow run, its `channel_settings` row, and its
`channel_launch` row all remain scoped to the **parent bench's** tenant id,
even after the child tenant exists. Re-homing the launch itself into the
child tenant would mean passing the child tenant id through
`@corbits/folded-runs`' launch, session-resolution, and credential/catalog
resolution paths — machinery this rollout was explicitly scoped not to
reach into (`packages/folded-runs` internals are off-limits here). The
child tenant that exists today is therefore a real, native, correctly
parented tenant — with its own owner principal, roles, and grants — that
currently serves as the channel's identity and listing anchor, while the
running instance continues to resolve against the parent bench's
inference/session/credential context.

Moving the launch itself into the child tenant is future work, gated on
`@corbits/folded-runs` exposing a tenant override for
launch/session/catalog resolution without requiring changes to its
internals.

## Upstream gaps (tracked, never faked)

Carried over from the platform tenancy inventory, and specifically
relevant to this feature:

- **No native child-tenant listing route.** `tenant.parentId` is stored
  but no route ever queries it; `ChannelTenancyStore` exists because of
  this gap.
- **No native `PATCH` for a tenant's `parentId`.** The move route updates
  the column directly through `@intx/db`'s schema instead.
- **`CreateTenant.parentId` is unvalidated server-side** on the native
  `POST /api/tenants` route — a caller can name any string as a parent, a
  gap `channel-tenancy.ts` does not introduce but also does not close,
  since it mints the child tenant directly rather than going through that
  HTTP route.
- **The move route does not verify `newParentTenantId` names a real
  tenant.** It writes the id straight through to both `channel_tenancy`
  and `tenant.parentId`, mirroring the same unvalidated-`parentId`
  posture as the native creation route above, rather than inventing a
  stricter contract only this one path enforces. Tightening both at once
  is future work, not something this rollout should do unilaterally to
  only one of the two paths.
