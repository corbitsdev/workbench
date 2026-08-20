# @corbits/workflow-catalog

Deploy-layer metadata for every seeded workflow package: display name,
whether it's schedulable as a routine, where its result actually lands
(a channel vs. the creator's Inbox only), required connections, and
optional trigger-input fields. Interchange's `defineWorkflow` has no
automatable/display-name concept of its own, so each `workflows/*/package.json`
carries a `corbits.workflow` block, and this package is the TypeScript
mirror both the seed script and the routines create picker import — the
browser never reads `package.json` at runtime.

## Composition with @intx/*

Pure, dependency-free at runtime beyond `arktype` for the `triggerFields`
schema — no `@intx/*` imports. It is consumed by `@corbits/routines` (to
decide whether a routine needs a delivery channel and to validate trigger
input) and by `@workbench/connections` (dev dependency only, for the
connector-id type trigger fields reference).

## Key modules

- `src/index.ts` — the entire package: `WORKFLOW_CATALOG` (the array of
  `WorkflowCatalogEntry` records, one per seeded workflow), `WorkflowTriggerField`
  (the arktype schema for a named trigger input), and the lookup helpers
  `isAutomatableWorkflowName`, `deliveryChannelRequiredForWorkflowName`,
  `workflowCatalogEntry`, `workflowDisplayName`, and
  `validateTriggerFieldsInput`.

## Keeping the mirror in sync

Each `workflows/*/package.json`'s `corbits.workflow` block is the
npm-visible source of truth for package authors; `WORKFLOW_CATALOG` here is
what runtime code actually reads. Adding or changing a workflow's catalog
facts means updating both — there is no codegen step keeping them in sync.

## Running tests

```
cd packages/workflow-catalog && bun test
```

No drizzle suite; no `DATABASE_URL` needed.
