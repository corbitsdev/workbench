# @corbits/bench-ui

Bench tenancy helpers over Interchange's native tenant model: classifying
memberships by kind, asking which tenant ids are workbench child tenancies,
and the shared tenancy contracts (roles, signup mode, DM naming, parent
cycle checks). Creation lives at `/new`; people management lives in
`@corbits/settings-ui`'s PeopleSection — this package no longer ships
switcher / create / members UI.

## Key modules

- `tenancy-kind.ts` — classifying a membership by tenancy kind
- `api.ts` — `listWorkbenchTenantIds` HTTP client
- `membership.ts` — `isRawIdentifier` (raw platform ids must never render)
- `tenancy-contracts.ts` — shared tenancy constants and validation (roles,
  signup mode, DM workbench naming, parent-tenant cycle checks)

## Running tests

```
cd packages/bench-ui && bun test
```
