# Tenancy — workbench contracts and Interchange gaps

Workbench tenancy is **not** a parallel product schema. Membership,
principals, grants, roles, and the tenant hierarchy live in Interchange
(`@intx/db`, `@intx/hub-api`). Workbench adds product contracts on top:
signup mode, workbench icons, DM workbench shape, invite links, and
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

`@workbench/access-policy` (CL-5886) is the actual enforcement point,
called from `packages/onboarding`'s first-login provisioning hook — it
is never patched into a vendor route. Two layers, in order:

1. **Bootstrap (env, no policy row yet)**: `WORKBENCH_SIGNUP=open|closed`
   (default **`closed`**) plus optional `WORKBENCH_ALLOWED_EMAIL_DOMAINS`
   (comma-separated). Local `bun run dev` injects `WORKBENCH_SIGNUP=open`
   when the variable is unset, so a zero-edit `.env` can still seed the
   admin account; an explicit value in `.env` always wins; production
   deploys that do not use the dev launcher keep the closed default.
2. **Policy row (operator tenant, once set)**: once `OPERATOR_TENANT_ID`
   carries an explicit `access_policy.policy` row (editable from Settings
   → People → "Who can join"), that row decides outright and the env
   flag is no longer consulted — `selfSignup` is `"off"`, `"allowed-
domains"` (with an `allowedDomains` list), or `"open"`. An absent row
   is closed defaults, identical in effect to `selfSignup: "off"`.

**closed** — self-serve email signup is rejected. An owner adds members
via the native invite/membership path, shares a **copy-link invite**
(token in the URL, out of scope for delivery), or pre-vets an email (or
a whole domain) as a **pending invite** — see below — before that person
ever logs in.

**Email must be verified.** better-auth is configured without
`requireEmailVerification`, so a freshly-registered address is not
proof of ownership on its own. Every email-trust decision
`@workbench/access-policy` makes — an allowed-domains match, an open-
policy pass, a pending-invite redemption — requires
`user.emailVerified === true`; an unverified email is denied, fail-
closed, regardless of what the policy or env otherwise allow.
`ALLOW_UNVERIFIED_EMAILS=1` opts out for local dev/test only, mirroring
`ALLOW_PLAINTEXT_SECRETS` — never set it for a real deployment.

**A policy row and the env switch can disagree**, and that disagreement
is not resolved automatically: `WORKBENCH_SIGNUP` also gates the
underlying better-auth `/sign-up/email` route directly (see
`apps/hub/src/index.ts`'s `authHandler`), independent of anything
`@workbench/access-policy` decides. Setting a bench's own policy to
`selfSignup: "allowed-domains"` or `"open"` while the operator's env
still has `WORKBENCH_SIGNUP=closed` does not open the sign-up form —
people still cannot create a password account at all, even though the
policy would otherwise let them join once they had one. The "Who can
join" settings panel surfaces this with an inline notice whenever the
policy would allow signup but the env switch is still closed, rather
than leaving it silently broken. There is no plan to make the policy
row flip the env switch automatically — the env switch is an operator
deployment fact, the policy row is a per-bench product setting, and the
mismatch is meant to be visible, not auto-resolved.

### Pending invites (the not-yet-registered-user bridge)

The native invite route (`POST /tenants/:id/members/invite`) requires an
existing `user` row looked up by email — it cannot invite someone who
has never signed in. `@workbench/access-policy` bridges that gap with
its own `pending_invite` table: an admin records an email (or a domain,
for a standing "anyone at this domain may join" rule) against a tenant
before that person has an account. On that email's first login, the
onboarding hook resolves the match, redeems it through the native invite
route (now that a user row exists) and an immediate activation, and
consumes an exact-email match (a domain match is a standing rule and is
never consumed).

### Workbench icon

Product metadata per tenant: monogram (1–2 characters) + color token.
Stored in a workbench-owned table (or tenant metadata when Interchange
exposes a stable product-metadata field). Served to the bench switcher
and avatar badges. See `WorkbenchIcon` in `@corbits/bench-ui`.

### Sub-workbench creation

**[Intx gap] CL-6041**: `POST /api/tenants` itself is ungated at the
platform level — any authenticated caller can hit it directly with an
arbitrary `parentId` and become owner of a child under any tenant,
bypassing the wrapper below entirely. Filed upstream; until it lands,
`apps/hub/src/tenant-create-guard.ts` wraps the whole hub app in a guard
registered in front of the native route (Hono composes handlers in
registration order, so this has to be an outer wrap, not a middleware
added after the route already exists) — see that file's module comment.
Every `POST /api/tenants` call, whoever originates it, is decided the
same way:

- No `parentId`, or `parentId` equal to the operator tenant: the
  signup gate (same decision as above) — this is the self-service
  landing zone.
- Any other `parentId`: the caller must already be a member of that
  exact tenant, with a role its own `tenancyCreation` policy accepts —
  `"owners"` (default), `"owners-admins"`, or `"none"`.

`@workbench/access-policy`'s `POST /api/tenants/:tenantId/access-policy/
child-tenants` is the polished UI-facing wrapper for creating a child
tenant under a parent — it makes the same decision and gives a clean
pre-flight 403, but the guard above is what actually closes the gap; the
wrapper alone would not.

Interchange currently does **not** validate `parentId` on POST and has
**no** cycle constraint — see gaps below.

### DM contract

A DM is a **two-member workbench** tenancy:

- Exactly two human principals (plus optional workbench-host agent).
- Auto-named from the counterparty display name.
- Flagged `dm: true` on the workbench record (workbench wire field).

Creation helper: `createDmWorkbenchSpec` in `@corbits/bench-ui`.

### Shared workbenches (Slack-Connect-style projection)

**Achievable today without Interchange changes (CL-5882):**

- A workbench owned by one tenant can be **projected** into a sibling
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
     tenant's own admin maintains (`workbench_share_member`, see
     `packages/chat/src/workbench-share.ts`), fully separate from the
     owning tenant's own `chat/participants`. Creating a share never
     auto-adds anyone; each side's own admin explicitly adds their own
     principals.
- `workbench_share` records that a projection exists; `workbench_share_member`
  records who, on the projected side, can actually see it.
  `packages/chat/src/routes.ts`'s `resolveWorkbenchAccess` is the one
  fail-closed gate every message/read-state/typing/stream/blob/block-response
  route resolves through: no share row → not found; a share row but the
  caller's principal was never added as a member → also not found — a
  third tenant with no share, and a projected tenant's principal nobody
  added, are both indistinguishable from "workbench doesn't exist" to the
  caller.
- The approval boundary is unchanged: every route still evaluates
  `requireGrant` against the ACTING tenant's own grants. A share never
  widens what a projected-tenant caller may do — it only widens which
  workbench that tenant's own rules apply to.
- `GET /workbenches` now sets a real `sharedLabel` for a workbench projected
  into the caller's tenant ("shared via parent · <name>" for true
  siblings sharing a parent, "shared · <owning tenant name>"
  otherwise), and a message's sender carries an optional
  `tenantId`/`tenantName`/`tenantMonogram` when it was sent by a share
  member of the "other side" — closing CL-5913 and CL-5881's tracked
  gap: the sidebar's per-row "shared" badge
  (`apps/web/src/shell/workbench-list.tsx`) and the timeline's
  tenant-monogram badge (`packages/chat-ui/src/timeline.tsx`) both
  render from this real signal now, never a guess from participant
  addresses.
- `GET /workbenches/:id/stream` enforces `resolveWorkbenchAccess` live, not
  only at connect time: `bridgeWorkbenchStream`
  (`packages/chat/src/workbench-events.ts`) re-runs the same fail-closed
  check before every event it writes, from either the local typing/
  settings registry or the platform's own event stream, and the moment
  it returns "no access" it unsubscribes from both sources and closes
  the connection. Revoking a `workbench_share_member` row or a
  `workbench_share` mid-connection stops that subscriber as of the next
  event published on the workbench — live relative to the workbench's own
  traffic, not an instant kill on a workbench that goes quiet (a truly
  instant kill would need a poll/heartbeat independent of traffic,
  which is out of scope here).

**Explicit scope boundary — what this does NOT do:**

- Settings (rename/pin/participant edits), invite, move, and thread
  routes remain owner-tenant-only. A projected tenant's member can read
  and post messages and see live events, but cannot administer the
  workbench. Widening that is future work, not silently implied here.
- Revoking bilateral trust does not cascade-delete existing shares —
  documented, known follow-up, not fixed here. A share created while
  trust existed keeps working after trust is revoked; only new share
  creation is gated by trust.
- Sibling benches under the same parent can still additionally be given
  ordinary native membership on the workbench's own tenant (the older,
  dual-membership path) — that path is unaffected by, and independent
  of, the projection machinery above.

### Tenancy kind (bench vs workbench child)

A native tenant row carries no `kind`/`type` field, so `/api/me/principals`
returns one row per tenant a principal belongs to — workbenches and
workbench child tenancies alike, indistinguishable to the platform. The
web client needs to treat only real workbenches as selectable benches, so
workbench owns the discriminator:

- `packages/chat`'s `workbench_tenancy` link table is the source of truth
  for "this tenant is a workbench". `WorkbenchTenancyStore.listWorkbenchTenantIds`
  answers it in bulk; `POST /api/workbench-tenancies/kinds` (mounted
  outside the tenant prefix, alongside `/api/onboarding`) exposes it to
  the web client for the caller's own tenant ids.
- `@corbits/bench-ui`'s `classifyBenchMembership` combines that set with
  `isRawIdentifier` (a tenant with no human-assigned name never renders,
  regardless of kind) to produce a `TenancyKind`: `"bench"`,
  `"workbench"`, or `"unknown"`. `filterBenchMemberships` is what callers
  use to keep only real benches.

This is the extension point for every other tenancy kind the product
adds (sub-workbenches, DMs, shared workbenches): each is still a tenant
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

6. **No native workbench-projection primitive** — Interchange itself has
   no concept of "project this workbench into another tenant"; workbench
   built the whole thing product-side on top of the native
   `federation_trust` table (see "Shared workbenches" above, CL-5882).
   What's still missing upstream: `federation_trust` has no cascade
   from trust revocation to anything workbench layers on top of it (by
   design — cascading is a product decision, not a platform one), and
   there's still no native notion of workbench membership scoped to a
   non-owning tenant, which is why `workbench_share`/`workbench_share_member`
   have to be workbench-owned tables rather than native ones.

7. **Signup is always open at the auth layer** — better-auth
   email+password enablement is hub-config, not a platform tenancy
   primitive. Workbench gates via `WORKBENCH_SIGNUP`.

8. **Invite is membership-side, not token-link** — native invite is
   "add principal"; copy-link invite tokens are a workbench product
   flow until the platform owns invite URLs.

9. **No tenant kind field** — `/api/me/principals` cannot say whether a
   tenant is a workbench, a workbench's own child tenancy, or anything
   else; workbench derives it from `workbench_tenancy` plus name shape
   (see "Tenancy kind" above) until the platform exposes one.

10. **[Intx gap] CL-6041 — `POST /api/tenants` has no grant/policy
    check of its own** — any authenticated user may call it directly
    with an arbitrary `parentId` and become owner of a freshly-minted
    child under any tenant. Workbench closes this with an outer guard
    in `apps/hub/src/tenant-create-guard.ts` (see "Sub-workbench
    creation" above) rather than waiting on an upstream fix; the
    platform should reject the request unless the caller already holds
    a create-child grant on `parentId`.

## Roles (mirror only)

| Role     | Product meaning                                      |
| -------- | ---------------------------------------------------- |
| `owner`  | Full control; create sub-workbenches; manage members |
| `admin`  | Manage members and settings; not ownership transfer  |
| `member` | Participate; no member admin                         |

Never invent `viewer`, `guest`, or parallel role tables. If the product
needs a weaker role, that is an Interchange conversation first.

## Related packages

- `@corbits/bench-ui` — tenancy-kind helpers, workbench-tenancy client, tenancy contracts
- `@workbench/onboarding` — personal bench provision under operator parent
- `@workbench/access-policy` — closed-by-default signup/sub-workbench-
  creation policy, pending invites (CL-5886)
- `apps/hub` — `WORKBENCH_SIGNUP`, invite routes, icon routes; one of the
  explicitly-listed apps/hub mounts pending extraction into a package (see
  [ARCHITECTURE.md](../ARCHITECTURE.md), CL-6127)
