# @corbits/bench

Per-bench purpose and type: a small side-table keyed by tenant id, since
benches ARE Interchange tenants (see
`vendor/intx/hub-api/src/routes/tenants.ts`) and the native tenant route
carries neither field. This package never adds a column to the vendor
`tenant` table — `bench_settings` is a package-owned table in its own
`bench` Postgres schema, the same shape `packages/chat`'s
`chat_bench_settings` uses for its own per-bench row.

## Composition over Interchange

- Benches are native tenants end to end; this package only opines on the
  two extra fields (`purpose`, `type`) the native tenant route doesn't
  carry.
- Routes mount under the tenant prefix and reuse `@intx/hub-api`'s
  `RequireGrant`/`TenantEnv` — no parallel auth model.

## Key modules

- `routes.ts` — tenant-scoped `bench-settings` API for the current
  tenant.
- `client.ts` — browser client for `/api/tenants/:id/bench-settings`;
  apps stay generic, so this fetch/parse logic lives here rather than in
  `packages/bench-ui` or `packages/settings-ui`.
- `store.ts` / `pg-store.ts` — the `BenchSettingsStore` interface and its
  Postgres implementation; partial patches use `COALESCE` per column
  rather than a jsonb merge.
- `schema.ts` — the `bench_settings` table, siloed in its own `bench`
  Postgres schema.
- `migrations.ts` — package-owned migrations with their own ledger
  table.

## Tests

```
cd packages/bench && bun test
```

`test/migrations.test.ts` needs a real database:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
