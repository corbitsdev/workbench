# @workbench/access-policy

Closed-by-default access policy for the hub: per-tenant self-signup and
sub-workbench creation rules, layered over Interchange's native
tenancy/RBAC without patching vendor routes. A pending invite resolves
through the native invite route (`POST /tenants/:id/members/invite`) plus
an immediate status flip to `"active"`, the same two primitives
`packages/settings-ui` already drives by hand — this package only decides
whether those calls are allowed to happen.

## Composition over Interchange

- No parallel tenancy or RBAC model: tenant creation, invites, and role
  checks all go through native `@intx/hub-api` routes and grants.
- `policy.ts` is the pure evaluation core (no DB, no HTTP, no env) —
  every decision (can this email self-sign-up, can this role create a
  sub-workbench) reduces to a function call over plain data.
- `gate.ts` composes `policy.ts` with `store.ts` for the two entry points
  `packages/onboarding`'s first-login hook calls.

## Key modules

- `policy.ts` — pure decision functions: `resolveAccessPolicy`,
  `domainAllowed`, `evaluateSignupGate`, `canCreateTenancy`.
- `gate.ts` — composes policy + store for the onboarding first-login hook.
- `routes.ts` — tenant-scoped HTTP surface: read/edit a tenant's own
  policy row, manage pending invites, and the gated
  `POST .../child-tenants` surface.
- `store.ts` — Postgres-backed persistence plus an in-memory fake for
  tests that don't need a real database.
- `schema.ts` — the two product tables (`policy`, `pending_invite`),
  siloed in their own `access_policy` Postgres schema, never `public`.
- `migrations.ts` — package-owned migrations with their own ledger table,
  so the package can be extracted without disentangling platform history.
- `types.ts` — arktype shapes for anything crossing a trust boundary
  (route bodies, DB columns).

## Tests

```
cd packages/access-policy && bun test
```

`test/store.drizzle.test.ts` needs a real database:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
