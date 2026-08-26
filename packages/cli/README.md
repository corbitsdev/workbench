# @workbench/cli

Curated setup and seed commands that take a fresh checkout to a
provisioned organization with the default workflows deployed and
confirmed. The `workbench` command has three verbs, no generic flags, and
no raw-API escape hatch — the same invocations serve local bootstrap and
hosted provisioning, and every one of them is safe to re-run.

## Composition over Interchange

- Tenant creation, authentication, and workflow deployment all go through
  `@workbench/hub-client`'s native hub calls — this package only sequences
  those calls and reports what happened.
- The tenant-seeding logic itself lives in `@workbench/hub-client`, not
  here, so other consumers (the first-login provisioning hook, in
  particular) depend on that package directly instead of on the CLI.
- Database initialization is owned by the shared `scripts/db-setup.ts`;
  `setup` shells out to it as a child process rather than
  re-implementing migrations.

## Key modules

- `index.ts` — entry point: parses the verb and dispatches.
- `config.ts` — the one place the CLI reads `process.env`; each verb has
  a single arktype schema, and every missing/malformed variable is
  reported at once with the exact fix.
- `setup.ts` — `workbench setup`: initializes the database, provisions
  the bench through the hub's native tenant-creation route, publishes
  the platform `corbits-tools` registry onto that root tenant
  (descendants inherit it), and reports the role defaults the platform
  created.
- `seed.ts` — `workbench seed`: authenticates as the administrator,
  resolves the configured bench by slug, and deploys the default
  workflow set. It does not pack tarballs.
- `reset.ts` — `workbench reset`: tears down local state (platform
  schema and on-disk asset directories) directly, without a hub call.
- `db-setup.ts` — child-process runners for the shared setup/reset
  scripts.
- `lib.ts` — the library entry: the env schemas `setup`/`seed` read, for
  consumers that don't want the CLI binary.

## Tests

```
cd packages/cli && bun test
```
