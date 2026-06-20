# @workbench/workflow-collateral-generation

The collateral-generation workflow: turn a call transcript into publishable
sales collateral, gated on human approval.

Steps:

1. **intake** — fetch a call transcript from Granola (or accept a pasted one).
2. **analyze** — extract key customer pain points from the transcript.
3. **generate** — draft sales collateral from the selected pain points.
4. **approval** — `awaitSignal('artifact-approval')`, a human gate before the
   collateral is considered done.

## Shape

This is a native `@intx/workflow` package. It exports:

- `kind` — `'collateral-generation'`
- `workflow` — a `defineWorkflow(...)` definition

Each step agent declares its tools as serializable `capabilities` (e.g.
`granola_get_note`, `artifact_create`), never inline tool factories — the
definition is pushed as JSON.

## Deploy

```bash
bun run workflows:push -- --kind collateral-generation
```

The hub imports no workflow code; it commits this definition to a git-backed
`workflow` repo and launches it on the sidecar. See
[../../docs/DEPLOYING_WORKFLOWS.md](../../docs/DEPLOYING_WORKFLOWS.md) for the
full deploy flow, authorization, and required credentials.
