# @corbits/approvals

Resolves a tenant's pending approvals — Interchange's own "needs you"
state — into a display-safe view model, and exposes it as a Hono route
factory the hub mounts alongside Interchange's native approve/reject
routes. This package never creates, resolves, or claims anything:
approving and rejecting stay on Interchange's own
`/api/tenants/:tenantId/approvals/:approvalId/{approve,reject}` routes,
whose authorize + claimTerminal + resolve transaction is already
exactly-once and grant-scoped. The one net-new concept here is naming —
turning raw approval rows into something safe to render.

## Composition over Interchange

- Reads through `@intx/db`'s `schema` and `parseApprovalRow`, and
  authorizes with `@intx/authz`'s `authorize` against the same grant and
  action (`approval:*` / `resolve`) the native list/resolve routes
  require, so the two surfaces never drift apart.
- Adds no parallel approval store or state machine — every identifier on
  an approval row is resolved into a name before `hydrateNeedsYou` (the
  view model's only producer) ever constructs a result, so nothing
  downstream can render a raw id even by accident.

## Key modules

- `routes.ts` — `createNeedsYouRoutes`: the tenant-scoped "needs you"
  list/detail surface, grant-checked before it queries.
- `view-model.ts` — `hydrateNeedsYou`, `headlineFor`, and the
  `NeedsYouItem` shape approvals hydrate into; carries the full
  `approval.status` union so a detail read can render
  approved/rejected/etc., not just pending.
- `index.ts` — package entry point.

## Tests

```
cd packages/approvals && bun test
```

`test/needs-you.test.ts` needs a real database:
`DATABASE_URL=postgres://localhost:5432/workbench_e2e bun test`.
