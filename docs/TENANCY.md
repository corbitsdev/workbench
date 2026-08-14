# Tenancy — workbench contracts and Interchange gaps

Workbench tenancy is **not** a parallel product schema. Membership,
principals, grants, roles, and the tenant hierarchy live in Interchange
(`@intx/db`, `@intx/hub-api`). Workbench adds product contracts on top:
signup mode, workbench icons, DM channel shape, invite links, and
parent-validation at creation time.

This document is the authoritative gap list for anything that still
requires an upstream Interchange change. **Do not patch `vendor/intx`.**

## What already works (consume, do not reimplement)

| Capability                      | Where                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Tenant `parentId` hierarchy     | `@intx/db` tenant table; POST `/api/tenants` accepts `parentId`                                        |
| Live ancestor-chain inheritance | `getAncestorChain` in `@intx/db` — catalog, credentials, providers walk ancestors at read time         |
| Descendant walk                 | `getDescendantTenants` in `@intx/db`                                                                   |
| Roles                           | Interchange native `owner` / `admin` / `member` — mirror 1:1 in UI; never invent a parallel role table |
| Personal bench parenting        | `packages/onboarding` parents under `OPERATOR_TENANT_ID` when set                                      |
| Memberships                     | Native principal + membership routes                                                                   |

Inheritance is **live**. Creating a sub-workbench must **not** copy
catalog rows, credentials, or providers from the parent — resolution
walks the chain on every read.

## Workbench-side contracts (this repo)

### Signup mode

Env: `WORKBENCH_SIGNUP=open|closed` (default **`closed`**).

- **closed** — self-serve email signup is rejected. An owner adds
  members via the native invite/membership path, or shares a
  **copy-link invite** (token in the URL). Email delivery of invites is
  out of scope.
- **open** — email+password signup is allowed (still rate-limited).
  Optional `WORKBENCH_ALLOWED_EMAIL_DOMAINS` (comma-separated) restricts
  which email domains may sign up when open.

Local `bun run dev` injects `WORKBENCH_SIGNUP=open` when the variable is
unset, so a zero-edit `.env` can still seed the admin account. An
explicit value in `.env` always wins. Production deploys that do not
use the dev launcher keep the closed default.

### Workbench icon

Product metadata per tenant: monogram (1–2 characters) + color token.
Stored in a workbench-owned table (or tenant metadata when Interchange
exposes a stable product-metadata field). Served to the bench switcher
and avatar badges. See `WorkbenchIcon` in `@corbits/bench-ui`.

### Sub-workbench creation

Workbench validates before calling native tenant create:

1. Caller is **owner** of the parent (or has an explicit grant the
   product treats as create-child).
2. `parentId` refers to an existing tenant the caller can see.
3. Cycle-safe: parent is not a descendant of the new tenant (for
   create this is trivial — the new id does not exist yet; for any
   future reparent it is required).

Interchange currently does **not** validate `parentId` on POST and has
**no** cycle constraint — see gaps below.

### DM contract

A DM is a **two-member channel** tenancy:

- Exactly two human principals (plus optional channel-host agent).
- Auto-named from the counterparty display name.
- Flagged `dm: true` on the channel record (workbench wire field).

Creation helper: `createDmChannelSpec` in `@corbits/bench-ui`.

### Shared channels (Slack-Connect-style projection)

**Achievable today without Interchange changes (CL-5882):**

- A channel owned by one tenant can be **projected** into a sibling
  tenant — no dual native membership required — gated by two
  workbench-owned facts, both required, neither implied by the other:
  1. **Bilateral federation trust** between the two tenants: both sides
     must hold a `direction: 'bilateral'` row naming the other, in
     Interchange's native `federation_trust` table (see
     `packages/chat/src/federation-trust.ts`, which reads/writes that
     table directly — it never forks
     `vendor/intx/hub-api/src/routes/tenant-federation.ts`). A single
     one-directional trust row is never enough.
  2. **An explicit per-principal share membership** the projected
     tenant's own admin maintains (`channel_share_member`, see
     `packages/chat/src/channel-share.ts`), fully separate from the
     owning tenant's own `chat/participants`. Creating a share never
     auto-adds anyone; each side's own admin explicitly adds their own
     principals.
- `channel_share` records that a projection exists; `channel_share_member`
  records who, on the projected side, can actually see it.
  `packages/chat/src/routes.ts`'s `resolveChannelAccess` is the one
  fail-closed gate every message/read-state/typing/stream/blob/block-response
  route resolves through: no share row → not found; a share row but the
  caller's principal was never added as a member → also not found — a
  third tenant with no share, and a projected tenant's principal nobody
  added, are both indistinguishable from "channel doesn't exist" to the
  caller.
- The approval boundary is unchanged: every route still evaluates
  `requireGrant` against the ACTING tenant's own grants. A share never
  widens what a projected-tenant caller may do — it only widens which
  channel that tenant's own rules apply to.
- `GET /channels` now sets a real `sharedLabel` for a channel projected
  into the caller's tenant ("shared via parent · <name>" for true
  siblings sharing a parent, "shared · <owning tenant name>"
  otherwise), and a message's sender carries an optional
  `tenantId`/`tenantName`/`tenantMonogram` when it was sent by a share
  member of the "other side" — closing CL-5913 and CL-5881's tracked
  gap: the sidebar's per-row "shared" badge
  (`apps/web/src/shell/panel-contributions.tsx`) and the timeline's
  tenant-monogram badge (`packages/chat-ui/src/timeline.tsx`) both
  render from this real signal now, never a guess from participant
  addresses.
- `GET /channels/:id/stream` enforces `resolveChannelAccess` live, not
  only at connect time: `bridgeChannelStream`
  (`packages/chat/src/channel-events.ts`) re-runs the same fail-closed
  check before every event it writes, from either the local typing/
  settings registry or the platform's own event stream, and the moment
  it returns "no access" it unsubscribes from both sources and closes
  the connection. Revoking a `channel_share_member` row or a
  `channel_share` mid-connection stops that subscriber as of the next
  event published on the channel — live relative to the channel's own
  traffic, not an instant kill on a channel that goes quiet (a truly
  instant kill would need a poll/heartbeat independent of traffic,
  which is out of scope here).

**Explicit scope boundary — what this does NOT do:**

- Settings (rename/pin/participant edits), invite, move, and thread
  routes remain owner-tenant-only. A projected tenant's member can read
  and post messages and see live events, but cannot administer the
  channel. Widening that is future work, not silently implied here.
- Revoking bilateral trust does not cascade-delete existing shares —
  documented, known follow-up, not fixed here. A share created while
  trust existed keeps working after trust is revoked; only new share
  creation is gated by trust.
- Sibling benches under the same parent can still additionally be given
  ordinary native membership on the channel's own tenant (the older,
  dual-membership path) — that path is unaffected by, and independent
  of, the projection machinery above.

### Tenancy kind (bench switcher)

A native tenant row carries no `kind`/`type` field, so `/api/me/principals`
returns one row per tenant a principal belongs to — workbenches and
channel child tenancies alike, indistinguishable to the platform. The
bench switcher needs to show only real workbenches, so workbench owns
the discriminator:

- `packages/chat`'s `channel_tenancy` link table is the source of truth
  for "this tenant is a channel". `ChannelTenancyStore.listChannelTenantIds`
  answers it in bulk; `POST /api/channel-tenancies/kinds` (mounted
  outside the tenant prefix, alongside `/api/onboarding`) exposes it to
  the web client for the caller's own tenant ids.
- `@corbits/bench-ui`'s `classifyBenchMembership` combines that set with
  `isRawIdentifier` (a tenant with no human-assigned name never renders,
  regardless of kind) to produce a `TenancyKind`: `"workbench"`,
  `"channel"`, or `"unknown"`. `filterWorkbenchMemberships` is what the
  switcher renders from.

This is the extension point for every other tenancy kind the product
adds (sub-workbenches, DMs, shared channels): each is still a tenant
underneath, and stays distinguishable only by adding a case to
`classifyBenchMembership`, never by inventing a parallel field on the
native tenant row.

## Interchange gaps (upstream only)

These are real platform holes. File them against Interchange; do not
fork or shim inside `vendor/intx`.

1. **No child-listing route** — there is no first-class
   `GET /api/tenants/:id/children`. Workbench can walk
   `getDescendantTenants` only when it has a DB handle (hub mount), not
   from a pure HTTP client. Prefer a hub-api children route.

2. **No `PATCH parentId`** — reparenting a tenant is not exposed. Sub-
   workbench moves require an upstream API.

3. **Unvalidated `parentId` on `POST /api/tenants`** — the platform
   accepts any string (or null). Workbench validates at the product
   layer; the platform should reject unknown parents and cycles.

4. **No cycle constraint** — nothing prevents A→B→A if reparent ever
   lands without a check.

5. **No product-metadata / icon field on tenant** — monogram+color is
   workbench-owned until Interchange offers stable tenant presentation
   metadata.

6. **No native channel-projection primitive** — Interchange itself has
   no concept of "project this channel into another tenant"; workbench
   built the whole thing product-side on top of the native
   `federation_trust` table (see "Shared channels" above, CL-5882).
   What's still missing upstream: `federation_trust` has no cascade
   from trust revocation to anything workbench layers on top of it (by
   design — cascading is a product decision, not a platform one), and
   there's still no native notion of channel membership scoped to a
   non-owning tenant, which is why `channel_share`/`channel_share_member`
   have to be workbench-owned tables rather than native ones.

7. **Signup is always open at the auth layer** — better-auth
   email+password enablement is hub-config, not a platform tenancy
   primitive. Workbench gates via `WORKBENCH_SIGNUP`.

8. **Invite is membership-side, not token-link** — native invite is
   "add principal"; copy-link invite tokens are a workbench product
   flow until the platform owns invite URLs.

9. **No tenant kind field** — `/api/me/principals` cannot say whether a
   tenant is a workbench, a channel's own child tenancy, or anything
   else; workbench derives it from `channel_tenancy` plus name shape
   (see "Tenancy kind" above) until the platform exposes one.

## Roles (mirror only)

| Role     | Product meaning                                      |
| -------- | ---------------------------------------------------- |
| `owner`  | Full control; create sub-workbenches; manage members |
| `admin`  | Manage members and settings; not ownership transfer  |
| `member` | Participate; no member admin                         |

Never invent `viewer`, `guest`, or parallel role tables. If the product
needs a weaker role, that is an Interchange conversation first.

## Related packages

- `@corbits/bench-ui` — switcher, create dialog, members, tenancy contracts
- `@workbench/onboarding` — personal bench provision under operator parent
- `apps/hub` — `WORKBENCH_SIGNUP`, invite routes, icon routes
