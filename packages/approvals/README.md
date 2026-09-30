# @corbits/approvals

Names an approval in words a person can act on. This package never creates,
resolves, or claims anything: listing, reading, approving and rejecting all
live on Interchange's own
`/api/tenants/:tenantId/approvals` routes, whose authorize +
claimTerminal + resolve transaction is already exactly-once and
grant-scoped.

## Key modules

- `headline.ts` — `headlineFor`: the pure headline builder, exported at
  `@corbits/approvals/headline` for browser callers.
- `index.ts` — package entry point.

## Tests

```
cd packages/approvals && bun test
```
