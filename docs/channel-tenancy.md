# Channel tenancy

Every channel `@corbits/chat` creates is minted as a native child tenant of
the bench it was created in, on Interchange's own parent/child tenant
hierarchy (`tenant.parentId`). This document describes the model, the seams
`@corbits/chat` owns because no native route covers them, and the gaps
still open upstream.

## Why channels are tenants

A channel needs its own membership and permissions — who can post, who can
invite an agent, who can move it — distinct from the bench it lives in.
Rather than invent a parallel, channel-scoped permission system alongside
Interchange's native grants, a channel is minted as an ordinary tenant: it
gets its own `owner`/`admin`/`member` roles and grants, seeded exactly as a
bench is, so a channel's membership is enforced with the same `@intx/authz`
machinery — `evaluateGrants`, `requireGrant` — every other tenant boundary
in the platform already uses. The tenant hierarchy (`tenant.parentId`) then
gives a channel a bench of origin without needing a second, chat-specific
notion of "which bench owns this channel."

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

   Compensation is itself a database write, and can itself fail — the
   same outage that failed the launch, for instance, can just as
   easily fail the cleanup. That double failure is caught separately:
   a compensation error is logged loudly on its own, tagged with the
   orphaned tenant id for an operator to clean up by hand, and the
   route always re-raises the **original** launch error, never the
   compensation error. A caller never sees "cleanup failed" in place
   of "your channel failed to launch," and a double failure never
   produces a silently swallowed exception — the accepted cost of a
   double failure is one privileged orphan tenant sitting in the
   database with a loud log line pointing at it, not data loss or a
   hung request.

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

The destination is verified and the move is written by the same call,
inside the same transaction — `ChannelTenancyStore.moveChannelTenancy`
takes the caller's `refId` alongside the channel and destination ids,
and re-checks the destination from inside its own transaction rather
than trusting a decision an earlier, separate read made:

- `newParentTenantId` must name a tenant that actually exists — a bogus
  or fabricated id is rejected with `404 not_found` rather than being
  written straight into `channel_tenancy` and `tenant.parentId`.
- The caller must hold an active principal in that destination tenant
  carrying a manage-level grant, evaluated with the same `@intx/authz`
  `evaluateGrants` logic `requireGrant` itself resolves against, against
  the destination tenant rather than the caller's own. A caller with
  only standing in the channel's current bench — including the bench
  that currently owns the channel — cannot move it into a tenant it has
  no authority over; that request is rejected with `403 forbidden`.

Both checks run under row locks (`SELECT ... FOR UPDATE`) taken on the
destination tenant row, the caller's principal row in that tenant, and
every grant row that could resolve the decision — all inside the
transaction that goes on to perform the two writes. This is not a
"check, then separately act" sequence: a grant revocation or a
destination-tenant deletion committed by another transaction blocks on
these locks until the move's transaction finishes, rather than landing
in a window between the check and the write and letting the move
proceed on since-revoked authority. `createDrizzleChannelTenancyStore`
is the only implementation of this — the row locks, and the real
`@intx/authz` `evaluateGrants` call, only exist on the Postgres-backed
store, never on the in-memory test double — and `test/isolation`'s
"chat channel move" suite drives it to a real `{ kind: "moved" }`
outcome end to end against Postgres, then re-reads both
`channel_tenancy.parent_tenant_id` and `tenant.parentId` fresh to
confirm the writes actually landed, rather than trusting the response
body alone.

A third check, structural rather than authorization-based, runs
alongside these two: `newParentTenantId` cannot be the channel's own
tenant, or descend from it. `moveChannelTenancy` walks the
destination's ancestor chain — under the same row locks, inside the
same transaction — looking for the channel's own tenant id; finding it
means completing the move would make the channel its own ancestor, so
the move is rejected with `{ kind: "cycle" }` (`409 conflict` over
HTTP) regardless of what grants the caller holds. `tenant.parentId` is
a plain self-referencing foreign key with no cycle constraint of its
own — Postgres will happily store a self-parent or a longer loop — so
this check is the only thing standing between a hierarchy this document
describes as a tree and one that, left unguarded, could become
cyclic. Nothing today walks `parentId` upward except this check itself,
so a cycle is not exploitable yet, but any future code that does
(breadcrumbs, an ancestor-scoped query, an admin tenant tree) would
infinite-loop on a cyclic tree with no way to detect how it got there.

## Indexing

`channel_tenancy` carries a `PRIMARY KEY (channel_id)` and a
`UNIQUE (tenant_id)`, but `listChildChannelTenancies` filters on
`parent_tenant_id`, a column neither constraint indexes. Migration
`0006_channel_tenancy_parent_index` adds
`channel_tenancy_parent_tenant_id_idx` on `parent_tenant_id` so that
read stays an index scan as the table grows, rather than a sequential
scan.

`GET .../chat/channels` itself reads tenancy by `channel_id` (the
primary key) instead, one call per listed row: a bench's channel
listing is scoped to `channel_settings`, which keeps a channel's row
forever in the bench it was created in even after a move, so annotating
those rows by "children of this bench" would go stale the moment a
channel moved elsewhere and wrongly report it as legacy.

## Scaling

Minting a channel tenant is not a single row. `createChannelTenant` seeds a
tenant, its three system roles, one owner principal, one principal-role
assignment, and five system grants (one on `owner`, three on `admin`, one
on `member`), plus the `channel_tenancy` link — a dozen native rows for
every channel created, on top of the `channel_settings` and
`channel_launch` rows chat already wrote before this feature. A workspace
with heavy channel churn multiplies its `tenant`/`role`/`principal`/
`grant` row counts accordingly; nothing about the mint amortizes this
across channels, since each one needs its own independent grant surface.

## Recovering an orphaned tenant

A tenant can be left behind with no channel pointing at it in exactly one
window: the mint's transaction commits, then the process dies before the
channel host launch call returns — there is no automated sweep for this
case, only the loud `channel-tenancy` log line `compensateChannelTenant`
already emits for the double-failure case (mint succeeded, launch failed,
_and_ compensation itself failed). Either way, an orphaned tenant is a
`tenant` row with no matching `channel_tenancy.tenant_id` and no
`channel_settings` row referencing it — reachable by diffing
`channel_tenancy` against `tenant.parentId` for the bench in question. It
carries no channel state, only its own owner principal, roles, and grants,
so deleting it (cascading through `role`, `principal`, `principal_role`,
`grant`) is safe once confirmed orphaned; there is no data recovery
question, only cleanup.

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
  creation route.** `ChannelTenancyStore.moveChannelTenancy` checks the
  destination tenant exists and that the caller holds a manage-level
  grant there, inside the same transaction that performs the move (see
  "Movability" above) — a stricter contract than `POST /api/tenants`'s
  unvalidated `parentId` enforces. Tightening the native route to match
  is future work upstream, not something this package can do from the
  outside.
