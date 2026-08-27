# @corbits/approvals

Decides when a tenant's standing grants already authorize a tool call, so
an agent is only stopped for a decision a human has not already made — and
names an approval in words a person can act on. This package never creates,
resolves, or claims anything: listing, reading, approving and rejecting all
live on Interchange's own
`/api/tenants/:tenantId/approvals` routes, whose authorize +
claimTerminal + resolve transaction is already exactly-once and
grant-scoped.

## Composition over Interchange

- The allowance gate evaluates the tenant's own grant rules through
  `@intx/authz`'s `evaluateGrants` — no parallel policy engine, and no
  approval store or state machine of its own.
- Names and statuses are read straight off Interchange's native approval
  and run views by whoever renders them; nothing here mirrors those rows.

## Key modules

- `allowance.ts` — `createToolAllowanceRegistry`, `evaluateToolAllowance`,
  `withGrantAllowance`: the gate that auto-approves a call an existing
  grant already covers.
- `headline.ts` — `headlineFor`: the pure headline builder, exported at
  `@corbits/approvals/headline` for browser callers (the root entry reaches
  server-only dependencies).
- `index.ts` — package entry point.

## Tests

```
cd packages/approvals && bun test
```
