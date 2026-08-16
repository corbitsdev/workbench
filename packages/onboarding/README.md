# @workbench/onboarding

First-login provisioning for the hub: a signed-in session with zero
principals gets a personal bench, and a guided credential step lets a new
user paste or connect their own inference-provider key before their first
workflow deploys.

## How it composes with Interchange

- `provision.ts`'s `provisionPersonalTenantIfNeeded` mints the personal
  bench through the hub's native tenant-creation route and
  `@workbench/hub-client`'s `seedTenant`/`DEFAULT_WORKFLOWS` — never a
  product-owned tenant table of its own.
- `complete-credential.ts` proves a pasted key with
  `@workbench/hub-client`'s `testProviderCredential` before storing it
  through the hub's native `POST /api/tenants/:id/credentials`
  (`ensureCredential`/`ensureProvider`), then runs the same
  `seedCatalog`/`seedTenant` path an operator-configured key runs.
- `huggingface-connect.ts` and `openrouter-connect.ts` are thin
  re-exports: the actual OAuth/PKCE connect mechanics live in
  `@workbench/connections` (CL-6028 generalized both flows into that
  package's OAuth route factory) and are kept here only so existing
  imports don't break.
- `@intx/crypto`'s `CredentialCipher` seals the plaintext key carried from
  an OAuth callback to onboarding's own follow-up request (see
  `pending-seed.ts`); `@workbench/access-policy` and `@workbench/hub-client`
  supply the grant and tenant primitives provisioning reuses.

## Key modules

- `provision.ts` — the first-login decision and personal-bench
  provisioning.
- `routes.ts` — `POST /provision`, mounted outside tenant-prefixed routes
  since a brand-new user belongs to no tenant yet.
- `complete-credential.ts` — the guided credential step: `
  testAndPersistCredential` (fast, safe for an OAuth callback to await)
  and `ensureSeeded` (slow, the workflow-deploy half, run separately so a
  browser is never left waiting mid-redirect).
- `pending-seed.ts` — server-side custody of a just-connected credential's
  plaintext key between the OAuth callback and the follow-up seed request.
- `schema.ts` / `migrations.ts` — the package's own `onboarding.pending_seed`
  table, in its own Postgres schema, with its own migration ledger.

## Running tests

```
cd packages/onboarding && bun test
```

`test/migrations.test.ts` and `test/pending-seed-store.drizzle.test.ts`
need a live Postgres: `DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
