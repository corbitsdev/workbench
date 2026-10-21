Follow the [root AGENTS.md](../../AGENTS.md).

- `src/server.ts` mirrors upstream Interchange's `server.ts` and delegates Workbench extensions to `src/corbits-mount.ts`.
- Mount only stock `@intx/hub-api` routes plus the Corbits mount block in `src/corbits-mount.ts`; any other hub mount is cutover debt with a Linear issue.
- Boot applies `@intx/db` platform migrations and each mounted Corbits library's idempotent migration in `src/migrate.ts`.
- Gate every tenant route with `createRequireGrant` and report background or callback errors through `reportError` from `@corbits/error-sink`.
