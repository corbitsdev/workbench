# @corbits/preferences

Per-(tenant, principal) UI preference store: a single JSONB bag persisted
across reload for small UI choices a surface wants to remember — e.g. col2
collapse state or theme. Keys are forward-compatible free-form strings
owned by whichever surface writes them; the package has no opinion on
their shape beyond "a plain JSON object", so a new key lands with no
migration.

## Composition

- `routes.ts` mounts under the tenant-session prefix using `@intx/hub-api`'s
  `RequireGrant`/`TenantEnv`; identity comes from the resolved
  tenant/principal, never a client-supplied value.
- `pg-store.ts` is the production `PreferencesStore`, backed by Drizzle +
  `postgres` against the package-owned `preferences` Postgres schema
  (`schema.ts`), fully siloed from the platform's `public` schema. The
  merge (`data || patch`) happens inside a Postgres upsert so concurrent
  patches from the same principal never race in application code; the
  patch is sent via `sql.json(...)`, not a `::jsonb`-cast string parameter,
  to avoid postgres.js silently treating `||` as array-append instead of
  object merge.
- `store.ts`'s `createMemoryPreferencesStore` is the in-memory fake tests
  and non-Postgres hosts use against the same `PreferencesStore` contract.
- `./client` subpath — a browser fetch/parse client against
  `/api/tenants/:id/preferences`, kept here rather than in `apps/web`
  per AGENTS.md's "apps stay generic" rule.
- Own migration ledger (`migrations.ts`) so the package's schema history
  stays extractable independent of the platform's drizzle journal.

## Key modules

- `routes.ts` — `createPreferencesRoutes`: GET (returns `{}` if no row)
  and PATCH (shallow-merge) over the tenant's preferences bag.
- `store.ts` — `PreferencesStore` contract + `createMemoryPreferencesStore`.
- `pg-store.ts` — `createPostgresPreferencesStore`: the Postgres-backed
  implementation.
- `schema.ts` — `userPreferences` Drizzle table, one JSONB row per
  (tenantId, principalId).
- `migrations.ts` — `applyPreferencesMigrations`, `preferencesMigrations`.
- `client.ts` (`./client` subpath) — browser fetch client, `PreferencesApiError`.

## Tests

```
cd packages/preferences && bun test
```

`test/migrations.test.ts` is DB-gated — skips without a reachable
Postgres, runs against its own scratch database otherwise. Set
`DATABASE_URL=postgres://localhost:5432/workbench_e2e` to exercise it.
