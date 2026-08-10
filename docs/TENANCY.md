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

### Shared channels (same-parent siblings)

**Achievable today without Interchange changes:**

- Channel runtime lives in **one** parent bench (the tenant that owns
  the channel row).
- Sibling benches under the same parent can be given membership on that
  parent (or on the channel's tenant) via native membership routes, so
  humans from sibling benches can participate when they are also
  principals of the parent.

**Not achievable workbench-side today:**

- Projecting a channel into a sibling tenant without dual membership.
- External cross-org connect (explicitly out of scope).

Document any product UX that implies "shared channel without dual
membership" as blocked on the projection gaps below.

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

6. **No channel projection primitives** — cannot project a channel into
   another tenant without dual membership; no shared-channel join
   without principal membership on the owning tenant.

7. **Signup is always open at the auth layer** — better-auth
   email+password enablement is hub-config, not a platform tenancy
   primitive. Workbench gates via `WORKBENCH_SIGNUP`.

8. **Invite is membership-side, not token-link** — native invite is
   "add principal"; copy-link invite tokens are a workbench product
   flow until the platform owns invite URLs.

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
