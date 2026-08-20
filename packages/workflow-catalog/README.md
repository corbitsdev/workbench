# @corbits/workflow-catalog

Deploy-layer metadata for every seeded workflow package: display name,
whether it's schedulable as a routine, where its result actually lands
(a channel vs. the creator's Inbox only), required connections, and
optional trigger-input fields. Interchange's `defineWorkflow` has no
automatable/display-name concept of its own, so each `workflows/*/package.json`
carries a `corbits.workflow` block, and this package is the TypeScript
mirror both the seed script and the routines create picker import — the
browser never reads `package.json` at runtime.

Also the home of **workbench templates** (`src/templates.ts`): a named
workbench worth having, assembled out of several catalog workflows, the
routines and webhook triggers that keep it running, the agents a person
talks to in it, and the open questions only they can answer. `apps/web`'s
`/new` picker and `instant-agent-create.ts` both read this as the single
description of what picking a template actually creates.

## Composition with @intx/*

No direct `@intx/*` imports. `src/templates.ts` and `src/instantiate.ts`
depend on `@corbits/code-review`, but only through its `./reviewers` and
`./agent-requests` subpaths — never the package root, which also
re-exports the review run and GitHub client and pulls in
`@corbits/github-tools` and `@intx/agent`'s full provider surface. Those
two files have no imports of their own, so this stays off that graph.
It is also consumed by `@corbits/routines` (to decide whether a routine
needs a delivery channel and to validate trigger input) and by
`@workbench/connections` (dev dependency only, for the connector-id type
trigger fields reference).

## Key modules

- `src/index.ts` — the catalog: `WORKFLOW_CATALOG` (the array of
  `WorkflowCatalogEntry` records, one per seeded workflow), `WorkflowTriggerField`
  (the arktype schema for a named trigger input), and the lookup helpers
  `isAutomatableWorkflowName`, `deliveryChannelRequiredForWorkflowName`,
  `workflowCatalogEntry`, `workflowDisplayName`, and
  `validateTriggerFieldsInput`.
- `src/templates.ts` — `WorkbenchTemplateManifest` and the templates
  themselves (`GTM_TEMPLATE`, `CODE_REVIEW_TEMPLATE`), each validated at
  module load; `workbenchTemplate(id)` looks one up.
- `src/instantiate.ts` — `instantiateWorkbenchTemplate`: resolves a
  manifest against a bench over injected ports (create the participant
  agent definitions that don't exist yet, record required connections as
  pending). Today this only supports a manifest whose participants are
  backed by `@corbits/code-review`'s reviewer roster.
- `src/settings.ts` — the `template/*` workbench-settings vocabulary a
  template-instantiated room persists about itself.

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
