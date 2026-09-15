# @workbench/onboarding

First-login provisioning for the hub: a signed-in session with zero
principals gets a personal bench, and a guided credential step lets a new
user paste or connect their own inference-provider key before their first
workflow deploys.

## How it composes with Interchange

- `provision.ts`'s `provisionPersonalTenantIfNeeded` mints the personal
  bench through the hub's native tenant-creation route and
  `@corbits/seeding`'s `seedTenant`/`DEFAULT_WORKFLOWS` — never a
  product-owned tenant table of its own.
- `complete-credential.ts` proves a pasted key with
  `@corbits/connections`'s `testProviderCredential` before storing it
  through the hub's native `POST /api/tenants/:id/credentials`
  (`ensureCredential`/`ensureProvider`), then runs the same
  `seedCatalog`/`seedTenant` path an operator-configured key runs.
- `huggingface-connect.ts` and `openrouter-connect.ts` are thin
  re-exports: the actual OAuth/PKCE connect mechanics live in
  `@corbits/connections` (CL-6028 generalized both flows into that
  package's OAuth route factory) and are kept here only so existing
  imports don't break.
- `@intx/crypto`'s `CredentialCipher` seals the OAuth connect state
  (PKCE verifier included) parked between `/start` and `/callback`
  (see `@corbits/connections`' `pkce.ts`); `@workbench/access-policy`
  and `@corbits/hub-api-client` supply the grant and tenant primitives
  provisioning reuses.

## Key modules

- `provision.ts` — the first-login decision and personal-bench
  provisioning.
- `routes.ts` — `POST /provision`, mounted outside tenant-prefixed routes
  since a brand-new user belongs to no tenant yet.
- `complete-credential.ts` — the guided credential step: `
testAndPersistCredential` (fast, safe for an OAuth callback to await)
  and `ensureSeeded` (slow, the workflow-deploy half, run separately so a
  browser is never left waiting mid-redirect).
- `desired-state.ts` — the desired-state reconcile and its status reader:
  connecting or polling a bench kicks the reconcile fire-and-forget and
  answers from hub reads (`ready` / `provisioning` / `unseeded`). There
  is no parked row and no deferred deploy step anywhere.
- `migrations.ts` — the package's migration ledger. `0001_pending_seed`
  stays so replays from an old base still run; `0002_drop_pending_seed`
  (CL-7586) drops the retired `onboarding.pending_seed` table, so a
  migrated database holds no pending-seed table anywhere.

## Running tests

```
cd packages/onboarding && bun test
```

`test/migrations.test.ts` needs a live Postgres:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e`.
