# @workbench/echo

The smallest hub extension, kept deliberately trivial: a tenant-scoped
route that echoes a `POST` body back verbatim as plain text. It exists as a
wiring check for the mail-triggered contract, not as a real assistant —
the `echo` entry in `@workbench/templates`'s `WORKFLOW_CATALOG`
describes it the same way.

## Composition with @intx/*

`createEchoRoutes` returns a `Hono<TenantEnv>` router (`@intx/hub-api`);
the hub mounts it inside the platform's native tenant middleware, so
tenant and principal are already resolved before the handler runs. No
other `@intx/*` or `@corbits/*` dependency.

## Key modules

- `src/routes.ts` — `createEchoRoutes`: `POST /` echoes the request body
  back as `text/plain`; every other method returns 405.
- `src/index.ts` — re-exports `createEchoRoutes`.

## Running tests

```
cd packages/echo && bun test
```

No drizzle suite; no `DATABASE_URL` needed.
