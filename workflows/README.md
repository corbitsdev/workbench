# Workflow packages

Each subdirectory is a deployable workflow package: an Interchange
`defineWorkflow` plus a `corbits.workflow` block in its `package.json`
that mirrors into `packages/workflow-catalog`'s `WORKFLOW_CATALOG` — the
deploy-layer metadata the seed step and the web Routines picker both
read (see that package's own doc comment for why the two must stay in
lockstep).

## Status note

Every workflow's README ends with one line pointing back here instead of
re-explaining these three independent flags each time:

- **Registered** — every workflow package here has a `WORKFLOW_CATALOG`
  entry, keyed by its asset name. This is how seed and the picker find
  it; it says nothing on its own about automation or defaults.
- **`automatable`** — whether the workflow is schedulable as a Routine
  and shows up in the Routines picker at all. `false` marks a
  conversational agent/chat host, a workflow spawned only as another
  workflow's child (never picked directly), or a workflow whose
  approval gate is a poor fit for unattended scheduling.
- **Seeded** — whether the workflow is provisioned into every tenant's
  bench by default, via `DEFAULT_WORKFLOWS` in
  `packages/hub-client/src/seed.ts`. A workflow can be `automatable`
  without being seeded (opt-in, e.g. because it needs a credential not
  every tenant has connected) — the two are independent decisions.
