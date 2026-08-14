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
child-tenants` is the polished UI-facing wrapper `@corbits/bench-ui`'s
`createBench` calls whenever a `parentId` is given — it makes the same
decision and gives a clean pre-flight 403, but the guard above is what
actually closes the gap; the wrapper alone would not.

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

The sidebar's per-row "shared" badge (CL-5881) is one such UX: `GET
/channels` never sets a `sharedLabel` signal, and
`apps/web/src/shell/panel-contributions.tsx` never renders one, because
there is no honest per-channel "is this projected across benches" fact
to show yet — see CL-5913 for the tracked follow-up once the
projection gaps below close.

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

6. **No channel projection primitives** — cannot project a channel into
   another tenant without dual membership; no shared-channel join
   without principal membership on the owning tenant.

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

- `@corbits/bench-ui` — switcher, create dialog, members, tenancy contracts
- `@workbench/onboarding` — personal bench provision under operator parent
- `@workbench/access-policy` — closed-by-default signup/sub-workbench-
  creation policy, pending invites (CL-5886)
- `apps/hub` — `WORKBENCH_SIGNUP`, invite routes, icon routes
