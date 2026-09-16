# @corbits/bench-ui

Bench tenancy helpers over Interchange's native tenant model: spotting raw
platform identifiers that must never render as bench names, and the shared
tenancy contracts (roles, signup mode, DM naming, parent
cycle checks). Creation lives at `/new`; people management lives in
`@corbits/settings-ui`'s PeopleSection — this package no longer ships
switcher / create / members UI.

## Key modules

- `membership.ts` — `isRawIdentifier` (raw platform ids must never render)
- `tenancy-contracts.ts` — shared tenancy constants and validation (roles,
  signup mode, DM workbench naming, parent-tenant cycle checks)

## Running tests

```
cd packages/bench-ui && bun test
```
