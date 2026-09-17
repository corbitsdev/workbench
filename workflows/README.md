# Workflow packages

Each subdirectory is a deployable workflow package: an Interchange
`defineWorkflow` plus a `corbits.workflow` block in its `package.json`
(`assetName`, `displayName`, `automatable`). `@corbits/workflows/catalog`'s
`WORKFLOW_CATALOG` reads that block straight off
each `package.json` at build time — via a static JSON import, not a
runtime file read, so it stays importable from the browser bundle — and
layers on the fields with no npm-visible home of their own (`whatItDoes`,
`requiredConnections`, trigger fields, …). There is nothing to keep in
lockstep: the `package.json` block IS the value the catalog reads.

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
- **Seeded** — historically, whether the workflow was provisioned into
  every tenant's bench by default via a hub-side seed step; CL-8207 deleted
  that step (the hub never seeds — the web client deploys only Myra, over
  stock routes, per tenant). A workflow can be `automatable` without being
  seeded (opt-in, e.g. because it needs a credential not every tenant has
  connected) — the two are independent decisions.
