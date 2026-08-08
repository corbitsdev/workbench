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
   hand through that route. The mint (tenant, its three system roles,
   the creator's owner principal and role assignment, every system
   grant, and the `channel_tenancy` link) runs as one transaction, so it
   either lands complete or not at all — there is no partially-seeded
   tenant to observe.
2. Seeds the child tenant's `owner` principal for the creator's own auth
   user id (`principal.refId`), so the creator is a first-class native
   member of the channel's own tenant, not just of the parent bench.
3. Records the parent↔child link in `channel_tenancy`
   (`packages/chat/src/schema.ts`), the table this package owns for
   exactly this purpose.
4. Launches the channel host and stores `channel_settings` /
   `channel_launch` unchanged from before this feature: both remain
   scoped to the parent bench's tenant id, not the new child tenant.
   The mint and the launch are two separate steps against separate
   machinery, so ordering them alone does not prevent an orphaned
   tenant if the launch fails: `POST .../chat/channels` wraps the
   launch call and, on failure, calls
   `ChannelTenancyStore.compensateChannelTenant` to delete the
   freshly-minted tenant (and everything cascaded onto it) before
   re-raising the error. Both the failure and the compensation are
   logged loudly.

Point 4's tenant/launch split is a deliberate, documented limitation —
see "What still lives in the parent bench" below.

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
  it stays explicit in the route and in this document instead. The chat
  sidebar (`packages/chat-ui/src/sidebar.tsx`) surfaces it too: a legacy
  channel's row carries a muted "Legacy" badge alongside its title, so
  the marker is visible to a human, not just present on the wire.

  Backfilling every legacy channel a tenancy — so this branch, the
  `legacy` field, and the badge can all be deleted — is tracked as a
  follow-up item on CL-5647's list, not scheduled here.

## Movability

`POST .../chat/channels/:id/move` re-parents a channel's tenancy to a new
bench. There is no native `PATCH` for a tenant's `parentId`, so the move
updates two places, both owned by this package's own service code, in one
transaction (`ChannelTenancyStore.moveChannelTenancy`):

1. The `channel_tenancy` link row (`parentTenantId`) — the source
   `listChildChannelTenancies` reads.
2. The native `tenant.parentId` column itself, directly, through
   `@intx/db`'s published schema (`import { tenant } from "@intx/db/schema"`)
   — this is ordinary consumption of a published table export, not a fork
   of `vendor/intx/hub-api`'s tenant routes.

A channel with no `channel_tenancy` link (a legacy channel) cannot be
moved; the route returns `409 conflict` rather than silently no-op'ing.

The route fails closed on the destination before either write happens,
via `ChannelTenancyStore.authorizeMoveDestination`:

- `newParentTenantId` must name a tenant that actually exists — a bogus
  or fabricated id is rejected with `404 not_found` rather than being
  written straight into `channel_tenancy` and `tenant.parentId`.
- The caller must hold an active principal in that destination tenant
  carrying a manage-level grant, checked with the same `@intx/authz`
  `authorize` call `requireGrant` itself uses, evaluated against the
  destination tenant rather than the caller's own. A caller with only
  standing in the channel's current bench — including the bench that
  currently owns the channel — cannot move it into a tenant it has no
  authority over; that request is rejected with `403 forbidden`.

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
- **The move route does verify `newParentTenantId`, unlike the native
  creation route.** `authorizeMoveDestination` checks the destination
  tenant exists and that the caller holds a manage-level grant there
  before either write happens (see "Movability" above) — a stricter
  contract than `POST /api/tenants`'s unvalidated `parentId` enforces.
  Tightening the native route to match is future work upstream, not
  something this package can do from the outside.
